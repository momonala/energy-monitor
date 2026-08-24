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


def test_online_reports_downtime_from_last_reading():
    """Downtime comes from the DB, so it survives a restart of this service mid-outage."""
    with patch("src.mqtt.time_since_last_reading", return_value=timedelta(days=7, hours=1)):
        with patch("src.mqtt.send_alert") as mock_alert:
            handle_lwt_status("Online")
    mock_alert.assert_called_once()
    assert "7d 1h 0m 0s" in mock_alert.call_args[0][0]


def test_online_with_empty_db_omits_downtime():
    with patch("src.mqtt.time_since_last_reading", return_value=None):
        with patch("src.mqtt.send_alert") as mock_alert:
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
