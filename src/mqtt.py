"""MQTT client service for receiving and processing energy meter data."""

import json
import queue
import sys
import threading

import paho.mqtt.client as mqtt

import src.observability  # noqa: F401
from src.config import MQTT_PORT
from src.config import SERVER_URL
from src.config import TOPIC
from src.database import init_db
from src.database import save_energy_reading
from src.observability import get_logger
from src.observability import metrics

logger = get_logger(__name__)

# Queue for database writes
db_queue = queue.Queue()

# Global MQTT client for status checks
_mqtt_client: mqtt.Client | None = None


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


def get_mqtt_client():
    """Get the MQTT client instance."""
    return _mqtt_client


def on_connect(client, userdata, flags, reason_code, properties):
    """Callback for when the MQTT client connects."""
    if reason_code.is_failure:
        logger.error(f"[connect] failed: {reason_code}")
        return
    logger.info("[connect] connected OK")
    client.subscribe(TOPIC)


def on_message(client, userdata, msg):
    """Callback for when the MQTT client receives a message."""
    try:
        payload = msg.payload.decode()
        # handle basic status messages
        if payload in ["Online", "Offline"]:
            metrics.increment("mqtt.messages.status")
            logger.debug(f"[msg] {msg.topic}: {payload}")
            return
        data = json.loads(payload)
        logger.debug(f"[msg] {msg.topic}: {data}")
    except json.decoder.JSONDecodeError:
        metrics.increment("mqtt.messages.decode_errors")
        logger.exception(f"[msg] {msg.topic}: {msg.payload}")
        return

    if "MT681" in data:
        metrics.increment("mqtt.messages.mqtt_reading")
        metrics.gauge("mqtt.db_queue.depth", db_queue.qsize())
        db_queue.put(data)  # enqueue DB write


def on_disconnect(client, userdata, reason_code, properties):
    """Callback for when the MQTT client disconnects."""
    metrics.increment("mqtt.disconnect")
    logger.info(f"[disconnect] code={reason_code}")


if __name__ == "__main__":
    init_db()

    if sys.platform == "darwin":
        logger.info("Using macOS, skipping MQTT loop")
        sys.exit(0)

    # Start DB worker thread
    worker_thread = threading.Thread(target=db_worker, daemon=True)
    worker_thread.start()
    logger.info("✅ Started DB worker thread")

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

    logger.info(f"🔌 Connecting to {SERVER_URL}:{MQTT_PORT} ...")
    _mqtt_client.connect(SERVER_URL, MQTT_PORT, keepalive=60)
    logger.info("✅ MQTT client connected, starting message loop")

    # Use loop_forever() to keep the process alive
    try:
        _mqtt_client.loop_forever()
    except KeyboardInterrupt:
        logger.info("🛑 Shutting down MQTT client")
        _mqtt_client.disconnect()
        db_queue.put(None)  # Signal worker to stop
