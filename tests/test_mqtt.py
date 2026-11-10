"""Tests for the MQTT ingestion service."""

from datetime import timedelta
from unittest.mock import patch

import pytest

from src.mqtt import format_downtime
from src.mqtt import handle_lwt_status


@pytest.mark.parametrize(
    "seconds,expected",
    [
        (0, "0d 0h 0m 0s"),
        (59, "0d 0h 0m 59s"),
        (3661, "0d 1h 1m 1s"),
        (601013, "6d 22h 56m 53s"),
    ],
)
def test_format_downtime(seconds, expected):
    assert format_downtime(seconds) == expected


NOW_MS = 1_700_000_000_000
WEEK_AND_HOUR_MS = int(timedelta(days=7, hours=1).total_seconds() * 1000)


@pytest.fixture(autouse=True)
def no_reading_since_startup(monkeypatch):
    monkeypatch.setattr("src.mqtt._last_reading_ms", None)


def test_online_reports_downtime_from_last_reading():
    """After a restart, downtime comes from the DB, so it survives a restart mid-outage."""
    with (
        patch("src.mqtt.last_reading_ms", return_value=NOW_MS - WEEK_AND_HOUR_MS),
        patch("src.mqtt.now_ms", return_value=NOW_MS),
        patch("src.mqtt.metrics") as mock_metrics,
        patch("src.mqtt.send_alert") as mock_alert,
    ):
        handle_lwt_status("Online")
    mock_alert.assert_called_once_with("Hardware device came *online* — down for `7d 1h 0m 0s`")
    mock_metrics.timing.assert_called_once_with("mqtt.device.downtime_ms", WEEK_AND_HOUR_MS)


def test_online_prefers_reading_received_since_startup(monkeypatch):
    monkeypatch.setattr("src.mqtt._last_reading_ms", NOW_MS - 61_500)
    with (
        patch("src.mqtt.last_reading_ms") as mock_db,
        patch("src.mqtt.now_ms", return_value=NOW_MS),
        patch("src.mqtt.send_alert") as mock_alert,
    ):
        handle_lwt_status("Online")
    mock_db.assert_not_called()
    mock_alert.assert_called_once_with("Hardware device came *online* — down for `0d 0h 1m 1s`")


def test_online_with_empty_db_omits_downtime():
    with (
        patch("src.mqtt.last_reading_ms", return_value=None),
        patch("src.mqtt.send_alert") as mock_alert,
    ):
        handle_lwt_status("Online")
    mock_alert.assert_called_once_with("Hardware device came *online*")


def test_offline_does_not_alert():
    """check_ingestion_stall is the sole owner of outage alerts, so LWT must stay quiet.

    These run in separate processes and cannot coordinate; alerting from both would report
    one outage twice, with only the LWT copy lacking a diagnosis.
    """
    with patch("src.mqtt.send_alert") as mock_alert:
        handle_lwt_status("Offline")
    mock_alert.assert_not_called()


@pytest.mark.parametrize(
    "flush_interval_s,expected_batches",
    [
        (3600, [[1, 2, 3]]),
        (0, [[1], [2], [3]]),
    ],
)
def test_db_worker_batches_per_flush_interval_and_flushes_on_stop(
    monkeypatch, flush_interval_s, expected_batches
):
    """Rows are committed together once per interval, and nothing buffered is lost on shutdown."""
    import src.mqtt

    monkeypatch.setattr(src.mqtt, "FLUSH_INTERVAL_SECONDS", flush_interval_s)
    saved = []
    for row in ({"timestamp_ms": 1}, {"timestamp_ms": 2}, {"timestamp_ms": 3}, None):
        src.mqtt.db_queue.put(row)
    with patch(
        "src.mqtt.save_energy_readings",
        side_effect=lambda rows: saved.append([r["timestamp_ms"] for r in rows]),
    ):
        src.mqtt.db_worker()
    assert saved == expected_batches
