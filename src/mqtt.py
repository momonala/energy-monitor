"""MQTT client service for receiving and processing energy meter data."""

import json
import queue
import sys
import threading
import time

import paho.mqtt.client as mqtt

import src.observability  # noqa: F401
from src.alerts import send_alert
from src.config import MQTT_PORT
from src.config import SERVER_URL
from src.config import TOPIC
from src.database import format_mt681_summary
from src.database import init_db
from src.database import save_energy_reading
from src.database import time_since_last_reading
from src.observability import get_logger
from src.observability import metrics

logger = get_logger(__name__)

db_queue = queue.Queue()

_last_sensor_time: float | None = None

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
        downtime = time_since_last_reading()
        if downtime is None:
            send_alert("Hardware device came *online*")
            return
        downtime_s = downtime.total_seconds()
        metrics.timing("mqtt.device.downtime_ms", downtime_s * 1000)
        logger.info(f"[recovery] device back online after {format_downtime(downtime_s)}")
        send_alert(f"Hardware device came *online* — down for `{format_downtime(downtime_s)}`")


def db_worker():
    """Single thread consuming DB writes."""
    while True:
        payload = db_queue.get()
        if payload is None:  # sentinel to stop
            break
        try:
            save_energy_reading(tasmota_payload=payload)
        except Exception:
            metrics.increment("mqtt.db_save.errors")
            logger.exception("Failed to save reading")
        finally:
            db_queue.task_done()


def on_connect(client, userdata, flags, reason_code, properties):
    """Callback for when the MQTT client connects."""
    if reason_code.is_failure:
        logger.error(f"[connect] failed: {reason_code}")
        return
    logger.info("[connect] connected OK, subscribing to %s", TOPIC)
    client.subscribe(TOPIC)


def on_message(client, userdata, msg):
    """Callback for when the MQTT client receives a message."""
    global _last_sensor_time
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
        if isinstance(mt_payload, dict):
            summary = format_mt681_summary(mt_payload)
        else:
            summary = f"payload_keys={list(data.keys())}"
        logger.debug("[mqtt] received SENSOR: %s", summary)
        metrics.increment("mqtt.messages.mqtt_reading")
        metrics.gauge("mqtt.db_queue.depth", db_queue.qsize())
        db_queue.put(data)
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

    try:
        client.loop_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down MQTT client")
        client.disconnect()
        db_queue.put(None)  # Signal worker to stop
