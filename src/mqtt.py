"""MQTT client service for receiving and processing energy meter data."""

import json
import queue
import signal
import sys
import threading
import time
from datetime import timedelta

import paho.mqtt.client as mqtt

import src.observability  # noqa: F401
from src.alerts import send_alert
from src.config import MQTT_PORT
from src.config import SERVER_URL
from src.config import TOPIC
from src.database import format_mt681_summary
from src.database import init_db
from src.database import parse_mt681
from src.database import save_energy_readings
from src.database import time_since_last_reading
from src.observability import get_logger
from src.observability import metrics

logger = get_logger(__name__)

db_queue = queue.Queue()

_last_sensor_time: float | None = None
_last_reading_ms: int | None = None
FLUSH_INTERVAL_SECONDS = 300

LWT_TOPIC = "tele/tasmota/LWT"
SENSOR_TOPIC = "tele/tasmota/SENSOR"
STATE_TOPIC = "tele/tasmota/STATE"
INFO3_TOPIC = "tele/tasmota/INFO3"


def format_downtime(seconds: float) -> str:
    """Format a duration compactly, e.g. '1d 2h 3m 4s'."""
    total = int(seconds)
    days, rem = divmod(total, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{days}d {hours}h {minutes}m {secs}s"


def handle_lwt_status(payload: str) -> None:
    """Record device offline/online transitions and alert the all-clear on recovery.

    Downtime is measured as the gap since the last stored reading rather than tracked in
    memory, so a restart of this service mid-outage does not reset the clock.
    """
    if payload == "Offline":
        # No alert here: check_ingestion_stall owns outage alerting, and it diagnoses the
        # cause rather than just reporting the symptom. Alerting from both would report the
        # same outage twice from two processes that cannot coordinate.
        metrics.increment("mqtt.device.offline")
        return
    if payload == "Online":
        metrics.increment("mqtt.device.online")
        downtime = time_since_last_received()
        if downtime is None:
            send_alert("Hardware device came *online*")
            return
        downtime_s = downtime.total_seconds()
        metrics.timing("mqtt.device.downtime_ms", downtime_s * 1000)
        logger.info(f"[recovery] device back online after {format_downtime(downtime_s)}")
        send_alert(f"Hardware device came *online* — down for `{format_downtime(downtime_s)}`")


def time_since_last_received() -> timedelta | None:
    """Time since this process last received a reading, falling back to the DB after a restart."""
    if _last_reading_ms is None:
        return time_since_last_reading()
    return timedelta(milliseconds=time.time() * 1000 - _last_reading_ms)


def _flush(rows: list[dict]) -> None:
    """Save and clear the buffered rows, keeping them for the next flush if the save fails."""
    if not rows:
        return
    try:
        save_energy_readings(rows)
    except Exception:
        metrics.increment("mqtt.db_save.errors")
        logger.exception("Failed to save %d readings, retrying next flush", len(rows))
        return
    rows.clear()


def db_worker():
    """Single thread consuming readings, committing them in one batch per flush interval."""
    rows: list[dict] = []
    next_flush = time.monotonic() + FLUSH_INTERVAL_SECONDS
    while True:
        try:
            row = db_queue.get(timeout=max(0.0, next_flush - time.monotonic()))
        except queue.Empty:
            row = None
        else:
            if row is None:  # sentinel to stop
                _flush(rows)
                return
            rows.append(row)
        if time.monotonic() >= next_flush:
            _flush(rows)
            next_flush = time.monotonic() + FLUSH_INTERVAL_SECONDS


def on_connect(client, userdata, flags, reason_code, properties):
    """Callback for when the MQTT client connects."""
    if reason_code.is_failure:
        logger.error(f"[connect] failed: {reason_code}")
        return
    logger.info("[connect] connected OK, subscribing to %s", TOPIC)
    client.subscribe(TOPIC)


def on_message(client, userdata, msg):
    """Callback for when the MQTT client receives a message."""
    global _last_sensor_time, _last_reading_ms
    try:
        payload = msg.payload.decode()
        # LWT is a plain-text status ("Online"/"Offline"), not JSON
        if msg.topic == LWT_TOPIC:
            metrics.increment("mqtt.messages.status")
            handle_lwt_status(payload)
            logger.info(f"[msg] {msg.topic}: {payload}")
            return
        data = json.loads(payload)
    except json.decoder.JSONDecodeError:
        metrics.increment("mqtt.messages.decode_errors")
        logger.exception(f"[msg] {msg.topic}: {msg.payload}")
        return

    if msg.topic == SENSOR_TOPIC:
        now = time.perf_counter()
        if _last_sensor_time is not None:
            metrics.timing("mqtt.sensor.interval_ms", (now - _last_sensor_time) * 1000)
        _last_sensor_time = now
        mt_payload = data.get("MT681")
        if not isinstance(mt_payload, dict):
            logger.warning("[mqtt] SENSOR without MT681: payload_keys=%s", list(data.keys()))
            return
        logger.debug("[mqtt] received SENSOR: %s", format_mt681_summary(mt_payload))
        metrics.increment("mqtt.messages.mqtt_reading")
        metrics.gauge("mqtt.db_queue.depth", db_queue.qsize())
        _last_reading_ms = int(time.time() * 1000)
        db_queue.put({"timestamp_ms": _last_reading_ms, **parse_mt681(mt_payload)})
    elif msg.topic == STATE_TOPIC:
        logger.debug("[msg] %s: %s", msg.topic, data)
    elif msg.topic == INFO3_TOPIC:
        metrics.increment("mqtt.device.errors")
        logger.warning(f"[msg] {msg.topic}: {data}")
    else:
        logger.warning(f"[msg] Unknown topic: {msg.topic}: {data}")


def on_disconnect(client, userdata, disconnect_flags, reason_code, properties):
    """Callback for when the MQTT client disconnects."""
    metrics.increment("mqtt.disconnect")
    logger.info(f"[disconnect] flags={disconnect_flags} code={reason_code}")


if __name__ == "__main__":
    init_db()

    if sys.platform == "darwin":
        logger.info("Using macOS, skipping MQTT loop")
        sys.exit(0)

    worker_thread = threading.Thread(target=db_worker, daemon=True)
    worker_thread.start()
    logger.info("Started DB worker thread")

    client = mqtt.Client(
        protocol=mqtt.MQTTv5,
        userdata=None,
        transport="tcp",
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    )
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    logger.info(f"Connecting to {SERVER_URL}:{MQTT_PORT} ...")
    client.connect(SERVER_URL, MQTT_PORT, keepalive=60)
    logger.info("MQTT client connected, starting message loop")

    signal.signal(signal.SIGTERM, lambda signum, frame: client.disconnect())
    try:
        client.loop_forever()
    except KeyboardInterrupt:
        client.disconnect()
    logger.info("Shutting down MQTT client, flushing buffered readings")
    db_queue.put(None)
    worker_thread.join()
