"""Tests for ingestion-stall classification."""

from unittest.mock import patch

import pytest

from src.config import GATEWAY_IP
from src.diagnostics import METER_IP
from src.diagnostics import classify_stall
from src.diagnostics import meter_wifi_summary

_STATUS_11 = {
    "StatusSTS": {
        "Uptime": "0T01:18:25",
        "Wifi": {"LinkCount": 1, "Downtime": "0T00:00:09", "Signal": -73},
    }
}


def _reach(gateway: bool, meter: bool):
    """Build a _reachable side effect keyed by the hop being probed."""
    verdicts = {GATEWAY_IP: gateway, METER_IP: meter}
    return lambda host: verdicts[host]


@pytest.mark.parametrize(
    "gateway,meter,wifi,expected_phrases",
    [
        (False, False, None, ["this host's own network link is down"]),
        (True, False, None, ["meter is offline"]),
        (True, True, None, ["wedged"]),
        (True, True, "wifi reconnects 1", ["suspect the broker or ingestion service", "wifi reconnects 1"]),
    ],
    ids=["host-link-down", "meter-offline", "meter-wedged", "network-fine"],
)
def test_classify_stall_names_the_fault_domain(gateway, meter, wifi, expected_phrases):
    with (
        patch("src.diagnostics._reachable", side_effect=_reach(gateway, meter)),
        patch("src.diagnostics.meter_wifi_summary", return_value=wifi),
    ):
        verdict = classify_stall()
    for phrase in expected_phrases:
        assert phrase in verdict


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
