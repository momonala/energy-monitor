"""Tests for Flask API endpoints."""

import re
from datetime import datetime
from datetime import timedelta
from unittest.mock import patch

import pytest

from src.app import _ingestion_state
from src.app import _scheduled_ingestion_watch
from src.helpers import local_timezone
from src.ingestion import IngestionState

NOW_MS = 1_700_000_000_000

_STYLESHEET_HREF_RE = re.compile(r'<link\s+rel="stylesheet"\s+href="([^"]+)"')


def test_linked_stylesheets_are_served(client):
    """Every stylesheet the rendered page links must exist and be served as CSS."""
    page = client.get("/")
    hrefs = _STYLESHEET_HREF_RE.findall(page.get_data(as_text=True))
    page.close()

    assert hrefs, "index page should link layered CSS files"

    for href in hrefs:
        response = client.get(href)
        assert response.status_code == 200, f"missing static asset: {href}"
        assert response.content_type.startswith("text/css"), href
        assert response.data.strip(), f"empty stylesheet: {href}"
        response.close()


IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148"


def test_index_redirects_mobile_until_desktop_chosen(client):
    """A phone lands on /mobile; the desktop link sticks until /mobile is visited again."""
    headers = {"User-Agent": IPHONE_UA}
    assert client.get("/", headers=headers).status_code == 302

    assert client.get("/?view=desktop", headers=headers).status_code == 200
    assert client.get("/", headers=headers).status_code == 200

    client.get("/mobile", headers=headers)
    assert client.get("/", headers=headers).status_code == 302


@pytest.mark.parametrize(
    "age_ms,receiving,seconds",
    [
        (5_000, True, 5.0),
        (60_000, False, 60.0),
        (None, False, None),
    ],
)
def test_status_reports_ingestion_health_from_reading_age(client, age_ms, receiving, seconds):
    """`receiving_readings` tracks reading recency, not an unreachable cross-process client."""
    with (
        patch("src.app.latest_energy_reading", return_value=None),
        patch("src.app.last_received_ms", return_value=None),
        patch("src.app.last_reading_ms", return_value=None if age_ms is None else NOW_MS - age_ms),
        patch("src.app.now_ms", return_value=NOW_MS),
        patch("src.app.num_energy_readings_last_hour", return_value=0),
        patch("src.app.num_total_energy_readings", return_value=0),
    ):
        data = client.get("/status").get_json()
        assert data["receiving_readings"] is receiving
        assert data["seconds_since_last_reading"] == seconds


def test_ingestion_state_prefers_live_feed_over_db():
    with (
        patch("src.app.last_received_ms", return_value=NOW_MS - 4_000),
        patch("src.app.last_reading_ms") as mock_db,
        patch("src.app.now_ms", return_value=NOW_MS),
    ):
        state = _ingestion_state()
    mock_db.assert_not_called()
    assert state.age == timedelta(seconds=4)


def test_ingestion_watch_passes_state_and_tick_to_stall_check():
    with (
        patch("src.app.last_received_ms", return_value=None),
        patch("src.app.last_reading_ms", return_value=NOW_MS - 120_000),
        patch("src.app.now_ms", return_value=NOW_MS),
        patch("src.app.check_ingestion_stall") as mock_check,
    ):
        _scheduled_ingestion_watch()
    mock_check.assert_called_once_with(IngestionState(timedelta(minutes=2)), timedelta(minutes=1))


def test_api_readings_accepts_time_params(client):
    """Readings endpoint accepts start/end parameters."""
    with patch("src.app.get_readings", return_value=[]):
        response = client.get("/api/readings?start=1704067200000&end=1704153600000")
        assert response.status_code == 200
        assert isinstance(response.get_json(), list)


def test_api_energy_summary_accepts_time_params(client):
    """Energy summary endpoint accepts start/end parameters."""
    with (
        patch("src.app.get_monthly_avg_daily_usage", return_value=5.0),
        patch("src.app.get_daily_energy_usage", return_value=[]),
        patch("src.app.get_moving_avg_daily_usage", return_value=[]),
    ):
        response = client.get("/api/energy_summary?start=1704067200000&end=1704153600000")
        assert response.status_code == 200
        data = response.get_json()
        assert data["avg_daily"] == 5.0
        assert data["daily"] == []
        assert data["moving_avg_30d"] == []


def test_api_energy_summary_without_params_uses_full_history(client):
    """Energy summary without params keeps full-history behavior for compare page."""
    with (
        patch("src.app.get_monthly_avg_daily_usage", return_value=5.0),
        patch("src.app.get_daily_energy_usage", return_value=[{"t": 1, "kwh": 1.0}]) as mock_daily,
        patch("src.app.get_moving_avg_daily_usage", return_value=[{"t": 1, "kwh": 1.0}]) as mock_moving,
    ):
        response = client.get("/api/energy_summary")
        assert response.status_code == 200
        mock_daily.assert_called_once_with(start=None, end=None)
        mock_moving.assert_called_once()


@pytest.mark.parametrize(
    "start,end,expected_status",
    [
        ("1704067200000", None, 400),
        (None, "1704067200000", 400),
        ("1704067200000", "1704153600000", 200),
    ],
)
def test_api_stats_requires_both_params(client, start, end, expected_status):
    """Stats endpoint validates required parameters."""
    query = []
    if start:
        query.append(f"start={start}")
    if end:
        query.append(f"end={end}")
    query_string = "&".join(query)

    with patch("src.app.get_stats", return_value={}):
        response = client.get(f"/api/stats?{query_string}")
        assert response.status_code == expected_status


def test_api_stats_swaps_inverted_range(client):
    """Stats endpoint handles end < start by swapping."""
    now = datetime.now(local_timezone())
    later = now + timedelta(hours=1)

    with (
        patch("src.app.parse_time_param") as mock_parse,
        patch("src.app.get_stats", return_value={}) as mock_stats,
    ):
        mock_parse.side_effect = [later, now]  # end, start - inverted
        response = client.get("/api/stats?start=later&end=now")
        assert response.status_code == 200
        # Verify get_stats was called with corrected order
        call_args = mock_stats.call_args[1]
        assert call_args["start"] == now
        assert call_args["end"] == later


@pytest.mark.parametrize(
    "endpoint,source",
    [("/api/live_power", "src.app.latest_power"), ("/api/latest_reading", "src.app.latest_energy_reading")],
)
def test_json_endpoints_return_their_source_payload(client, endpoint, source):
    payload = {"t": 1701432000000, "w": None, "stale": True}
    with patch(source, return_value=payload):
        response = client.get(endpoint)
    assert response.status_code == 200
    assert response.get_json() == payload
