"""In-memory feed of the newest meter readings for the Flask process.

The MQTT service batches DB writes, so the DB can lag the meter by minutes. This process
subscribes to the meter itself, so live views and stall detection never wait on a flush.
"""

import json
import threading
import time
from collections import deque
from datetime import timedelta

import paho.mqtt.client as mqtt

from src.config import MQTT_PORT
from src.config import SERVER_URL
from src.database import RAW_READING_INTERVAL_MS
from src.database import parse_mt681
from src.mqtt import FLUSH_INTERVAL_SECONDS
from src.mqtt import SENSOR_TOPIC
from src.observability import get_logger

logger = get_logger(__name__)

# Readings arrive roughly every 10s; a minute without one means the feed is broken, not slow.
LIVE_POWER_STALE_SECONDS = 60

# Covers everything the MQTT service may not have flushed yet, with a margin for a slow flush.
RECENT_READINGS_MAXLEN = 2 * FLUSH_INTERVAL_SECONDS * 1000 // RAW_READING_INTERVAL_MS

# This process stamps its own receive time, a few ms off the MQTT service's stamp for the
# same reading, so a recent reading only counts as unsaved if it is this far past the DB.
_SAME_READING_TOLERANCE_MS = RAW_READING_INTERVAL_MS // 2

_lock = threading.Lock()
_recent: deque[dict] = deque(maxlen=RECENT_READINGS_MAXLEN)


def _now_ms() -> int:
    return int(time.time() * 1000)


def record_sensor_payload(payload: dict) -> None:
    """Keep a SENSOR payload as a {t, p, e} reading stamped with its receive time."""
    mt_payload = payload.get("MT681")
    if not isinstance(mt_payload, dict):
        return
    fields = parse_mt681(mt_payload)
    with _lock:
        _recent.append({"t": _now_ms(), "p": fields["power_watts"], "e": fields["energy_in_kwh"]})


def latest_power() -> dict:
    """The newest instantaneous power draw for the live readout, or nulls before the first reading."""
    with _lock:
        newest = _recent[-1] if _recent else None
    if newest is None:
        return {"t": None, "w": None, "age_s": None, "stale": True}
    age_s = (_now_ms() - newest["t"]) / 1000
    return {
        "t": newest["t"],
        "w": newest["p"],
        "age_s": round(age_s, 1),
        "stale": age_s > LIVE_POWER_STALE_SECONDS,
    }


def time_since_last_received() -> timedelta | None:
    """Time since this process last received a reading, or None before the first one."""
    with _lock:
        newest_ms = _recent[-1]["t"] if _recent else None
    if newest_ms is None:
        return None
    return timedelta(milliseconds=_now_ms() - newest_ms)


def append_unsaved_readings(rows: list[dict], start_ms: int, end_ms: int, bucket_ms: int) -> list[dict]:
    """Extend DB readings with the recent ones the MQTT service has not flushed yet.

    `rows` are {t, p, e} dicts ordered by t, as returned by `get_readings` with `bucket_ms`.
    Recent readings are bucketed the same way (max per bucket), and a bucket the DB already
    returned is left alone rather than merged.
    """
    saved_until_ms = rows[-1]["t"] + _SAME_READING_TOLERANCE_MS if rows else start_ms
    with _lock:
        unsaved = [r for r in _recent if saved_until_ms < r["t"] <= end_ms]
    if bucket_ms <= RAW_READING_INTERVAL_MS:
        return rows + unsaved

    last_saved_bucket = rows[-1]["t"] // bucket_ms if rows else None
    buckets: dict[int, list[dict]] = {}
    for reading in unsaved:
        bucket = reading["t"] // bucket_ms
        if bucket != last_saved_bucket:
            buckets.setdefault(bucket, []).append(reading)
    return rows + [
        {
            "t": max(r["t"] for r in readings),
            "p": max((r["p"] for r in readings if r["p"] is not None), default=None),
            "e": max((r["e"] for r in readings if r["e"] is not None), default=None),
        }
        for _, readings in sorted(buckets.items())
    ]


def _on_connect(client, userdata, flags, reason_code, properties):
    if reason_code.is_failure:
        logger.error(f"[live] connect failed: {reason_code}")
        return
    client.subscribe(SENSOR_TOPIC)


def _on_message(client, userdata, msg):
    try:
        record_sensor_payload(json.loads(msg.payload))
    except json.JSONDecodeError:
        logger.warning("[live] undecodable SENSOR payload: %r", msg.payload)


def start_live_feed() -> None:
    """Subscribe to the meter in a background thread that reconnects on its own."""
    client = mqtt.Client(protocol=mqtt.MQTTv5, callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = _on_connect
    client.on_message = _on_message
    client.connect_async(SERVER_URL, MQTT_PORT, keepalive=60)
    client.loop_start()
    logger.info(f"[live] subscribing to {SENSOR_TOPIC} on {SERVER_URL}:{MQTT_PORT}")
