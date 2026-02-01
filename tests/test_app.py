"""Tests for Flask API endpoints."""

from datetime import datetime
from datetime import timedelta
from unittest.mock import patch

import pytest

from src.helpers import local_timezone


def test_index_serves_static_file(client):
    """Frontend route serves index.html."""
    response = client.get("/")
    assert response.status_code == 200
    assert response.content_type == "text/html; charset=utf-8"
    assert b"<html" in response.data or b"<!DOCTYPE html>" in response.data


@pytest.mark.parametrize(
    "endpoint,expected_keys",
    [
        ("/api/latest_reading", None),
        ("/status", ["status", "mqtt_connected", "topic"]),
    ],
)
def test_api_endpoints_return_json(client, endpoint, expected_keys):
    """API endpoints return valid JSON."""
    with patch("src.app.latest_energy_reading", return_value={"timestamp": "2024-01-01T00:00:00"}):
        with patch("src.app.get_mqtt_client") as mock_mqtt:
            mock_mqtt.return_value.is_connected.return_value = True
            with patch("src.app.num_energy_readings_last_hour", return_value=100):
                with patch("src.app.num_total_energy_readings", return_value=1000):
                    response = client.get(endpoint)
                    assert response.status_code == 200
                    data = response.get_json()
                    assert isinstance(data, dict)
                    if expected_keys:
                        for key in expected_keys:
                            assert key in data


def test_api_readings_accepts_time_params(client):
    """Readings endpoint accepts start/end parameters."""
    with patch("src.app.get_readings", return_value=[]):
        response = client.get("/api/readings?start=1704067200000&end=1704153600000")
        assert response.status_code == 200
        assert isinstance(response.get_json(), list)


@pytest.mark.parametrize(
    "start,end,expected_status",
    [
        (None, None, 400),
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

    with patch("src.app.parse_time_param") as mock_parse:
        with patch("src.app.get_stats", return_value={}) as mock_stats:
            mock_parse.side_effect = [later, now]  # end, start - inverted
            response = client.get("/api/stats?start=later&end=now")
            assert response.status_code == 200
            # Verify get_stats was called with corrected order
            call_args = mock_stats.call_args[1]
            assert call_args["start"] == now
            assert call_args["end"] == later


def test_clear_cache_returns_previous_stats(client):
    """Cache clear endpoint returns previous cache statistics."""
    with patch("src.app.get_readings") as mock_readings:
        mock_readings.cache_info.return_value = type(
            "CacheInfo", (), {"hits": 10, "misses": 2, "currsize": 5}
        )()
        response = client.get("/api/clear_cache")
        assert response.status_code == 200
        data = response.get_json()
        assert data["cleared"] is True
        assert data["previous"]["hits"] == 10
        assert data["previous"]["misses"] == 2
