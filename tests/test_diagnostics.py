"""Tests for ingestion-stall classification."""

from datetime import timedelta
from unittest.mock import patch

import pytest

from src.diagnostics import classify_stall
from src.diagnostics import meter_wifi_summary

_STATUS_11 = {
    "StatusSTS": {
        "Uptime": "0T01:18:25",
        "Wifi": {"LinkCount": 1, "Downtime": "0T00:00:09", "Signal": -73},
    }
}


def _reach(gateway: bool, access_point: bool, meter: bool):
    """Build a _reachable side effect keyed by the hop being probed."""
    verdicts = {"192.168.2.1": gateway, "192.168.2.102": access_point, "192.168.2.116": meter}
    return lambda host: verdicts[host]


@pytest.mark.parametrize(
    "gateway,access_point,meter,expected_phrase",
    [
        (False, False, False, "this host's own network link is down"),
        # The Aug 2026 outage: the meter was healthy, the path to it was not.
        (True, False, False, "LAN path fault"),
        (True, True, False, "meter is offline"),
    ],
)
def test_classify_stall_names_the_fault_domain(gateway, access_point, meter, expected_phrase):
    with patch("src.diagnostics._reachable", side_effect=_reach(gateway, access_point, meter)):
        assert expected_phrase in classify_stall()


def test_reachable_meter_that_never_dropped_wifi_points_away_from_the_network():
    """All hops up and LinkCount=1 means the radio held — blame the broker, not the LAN."""
    with patch("src.diagnostics._reachable", side_effect=_reach(True, True, True)):
        with patch("src.diagnostics.meter_wifi_summary", return_value="wifi reconnects 1"):
            verdict = classify_stall()
    assert "suspect the broker or ingestion service" in verdict
    assert "wifi reconnects 1" in verdict


def test_pingable_but_wedged_meter_is_called_out_separately():
    with patch("src.diagnostics._reachable", side_effect=_reach(True, True, True)):
        with patch("src.diagnostics.meter_wifi_summary", return_value=None):
            assert "wedged" in classify_stall()


def test_meter_wifi_summary_reports_radio_counters():
    class _Response:
        def read(self):
            import json

            return json.dumps(_STATUS_11).encode()

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    with patch("src.diagnostics.urllib.request.urlopen", return_value=_Response()):
        summary = meter_wifi_summary()
    assert "wifi reconnects 1" in summary
    assert "RSSI -73dBm" in summary


def test_meter_wifi_summary_returns_none_when_unreachable():
    with patch("src.diagnostics.urllib.request.urlopen", side_effect=OSError("no route")):
        assert meter_wifi_summary() is None


def test_check_ingestion_stall_only_probes_on_a_threshold_crossing():
    """Diagnosis hits the network, so it must not run on every one-minute tick."""
    from src.database import check_ingestion_stall

    tick = timedelta(minutes=1)
    with patch("src.database.classify_stall", return_value="diagnosis") as mock_classify:
        with patch("src.database.send_alert") as mock_alert:
            with patch("src.database.time_since_last_reading", return_value=timedelta(minutes=3)):
                check_ingestion_stall(tick)  # between thresholds
            mock_classify.assert_not_called()
            mock_alert.assert_not_called()

            with patch("src.database.time_since_last_reading", return_value=timedelta(minutes=15)):
                check_ingestion_stall(tick)  # on a threshold
            mock_classify.assert_called_once()
            assert "diagnosis" in mock_alert.call_args[0][0]


def test_check_ingestion_stall_is_quiet_on_an_empty_database():
    from src.database import check_ingestion_stall

    with patch("src.database.time_since_last_reading", return_value=None):
        with patch("src.database.send_alert") as mock_alert:
            check_ingestion_stall(timedelta(minutes=1))
    mock_alert.assert_not_called()
