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
from src.observability import get_logger
from src.observability import metrics

logger = get_logger(__name__)

# Queue for database writes
db_queue = queue.Queue()

# Global MQTT client for status checks
_mqtt_client: mqtt.Client | None = None
_last_sensor_time: float | None = None

LWT_TOPIC = "tele/tasmota/LWT"
SENSOR_TOPIC = "tele/tasmota/SENSOR"
STATE_TOPIC = "tele/tasmota/STATE"
INFO3_TOPIC = "tele/tasmota/INFO3"


def db_worker():
    """Single thread consuming DB writes."""
    while True:
        item = db_queue.get()
        if item is None:  # sentinel to stop
            break
        payload, enqueued_at = item
        wait_ms = (time.perf_counter() - enqueued_at) * 1000
        metrics.timing("mqtt.db_queue.wait_ms", wait_ms)
        try:
            save_energy_reading(tasmota_payload=payload)
        except Exception:
            metrics.increment("mqtt.db_save.errors")
            logger.exception("Failed to save reading")
        finally:
            db_queue.task_done()


def get_mqtt_client():
    """Get the MQTT client instance."""
    return _mqtt_client


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
        # handle basic status messages
        if msg.topic == LWT_TOPIC:
            metrics.increment("mqtt.messages.status")
            if payload == "Offline":
                metrics.increment("mqtt.device.offline")
                send_alert("Hardware device went *offline*")
            elif payload == "Online":
                metrics.increment("mqtt.device.online")
                send_alert("Hardware device came *online*")
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
        db_queue.put((data, time.perf_counter()))
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

    # Start DB worker thread
    worker_thread = threading.Thread(target=db_worker, daemon=True)
    worker_thread.start()
    logger.info("Started DB worker thread")

    # Create and configure MQTT client with callback API version 2
    _mqtt_client = mqtt.Client(
        protocol=mqtt.MQTTv5,
        userdata=None,
        transport="tcp",
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    )
    _mqtt_client.on_connect = on_connect
    _mqtt_client.on_disconnect = on_disconnect
    _mqtt_client.on_message = on_message

    logger.info(f"Connecting to {SERVER_URL}:{MQTT_PORT} ...")
    _mqtt_client.connect(SERVER_URL, MQTT_PORT, keepalive=60)
    logger.info("MQTT client connected, starting message loop")

    # Use loop_forever() to keep the process alive
    try:
        _mqtt_client.loop_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down MQTT client")
        _mqtt_client.disconnect()
        db_queue.put(None)  # Signal worker to stop
