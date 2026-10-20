"""Tests for the Flask process's in-memory live feed."""

from unittest.mock import patch

import pytest

import src.live
from src.live import append_unsaved_readings
from src.live import latest_power
from src.live import record_sensor_payload


@pytest.fixture(autouse=True)
def empty_feed():
    src.live._recent.clear()
    yield
    src.live._recent.clear()


def _receive(t_ms: int, power: float, energy: float) -> None:
    with patch("src.live._now_ms", return_value=t_ms):
        record_sensor_payload({"MT681": {"Power": power, "E_in": energy}})


def test_latest_power_before_first_reading_is_null():
    assert latest_power() == {"t": None, "w": None, "age_s": None, "stale": True}


@pytest.mark.parametrize("age_ms,stale", [(4_000, False), (120_000, True)])
def test_latest_power_reports_newest_reading_and_staleness(age_ms, stale):
    _receive(1_000_000, 300.0, 10.0)
    _receive(1_010_000, 512.0, 10.1)
    with patch("src.live._now_ms", return_value=1_010_000 + age_ms):
        result = latest_power()
    assert result["w"] == 512.0
    assert result["t"] == 1_010_000
    assert result["stale"] is stale


def test_append_unsaved_readings_raw_skips_already_saved():
    """The DB copy of a reading carries the MQTT service's stamp, a few ms off this process's."""
    for t in (100_000, 110_000, 120_000):
        _receive(t, float(t), 1.0)
    saved = [{"t": 109_997, "p": 110_000.0, "e": 1.0}]
    merged = append_unsaved_readings(saved, start_ms=0, end_ms=200_000, bucket_ms=0)
    assert [r["t"] for r in merged] == [109_997, 120_000]


def test_append_unsaved_readings_buckets_and_leaves_saved_bucket_alone():
    for t, p in ((117_000, 3.0), (125_000, 1.0), (130_000, 5.0), (245_000, 2.0), (250_000, 7.0)):
        _receive(t, p, p)
    saved = [{"t": 110_000, "p": 9.0, "e": 9.0}]
    merged = append_unsaved_readings(saved, start_ms=0, end_ms=300_000, bucket_ms=120_000)
    assert merged == [
        saved[0],
        {"t": 130_000, "p": 5.0, "e": 5.0},
        {"t": 250_000, "p": 7.0, "e": 7.0},
    ]


def test_append_unsaved_readings_respects_end():
    _receive(100_000, 1.0, 1.0)
    assert append_unsaved_readings([], start_ms=0, end_ms=50_000, bucket_ms=0) == []
