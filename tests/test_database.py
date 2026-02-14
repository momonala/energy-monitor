"""Tests for database operations."""

from datetime import datetime
from datetime import timedelta

import pytest

from src.database import get_daily_energy_usage
from src.database import get_moving_avg_daily_usage
from src.database import get_stats
from src.helpers import local_timezone


def test_daily_energy_usage_groups_by_day(test_db, sample_readings):
    """Daily usage groups readings by calendar day (SQL version)."""
    import src.database

    original_session = src.database.SessionLocal
    src.database.SessionLocal = test_db

    try:
        start = sample_readings[0]["timestamp"]
        end = sample_readings[-1]["timestamp"]
        daily = get_daily_energy_usage(start=start, end=end)
        assert len(daily) >= 3
        for row in daily:
            assert "t" in row
            assert "kwh" in row
            assert "is_partial" in row
            assert isinstance(row["t"], int)
            assert isinstance(row["kwh"], (int, float))
            assert isinstance(row["is_partial"], bool)
    finally:
        src.database.SessionLocal = original_session


def test_daily_energy_usage_marks_partial_days(test_db):
    """Days with less than 23 hours coverage are marked partial."""
    import src.database
    from src.database import EnergyReading

    original_session = src.database.SessionLocal
    src.database.SessionLocal = test_db

    try:
        session = test_db()
        now = datetime.now(local_timezone())
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        for i in range(2):
            ts = today_start + timedelta(hours=i)
            session.add(
                EnergyReading(
                    timestamp=ts,
                    meter_id="test",
                    power_watts=500.0,
                    energy_in_kwh=100.0 + i * 0.5,
                    energy_out_kwh=0.0,
                    raw_payload="{}",
                )
            )
        session.commit()
        session.close()

        daily = get_daily_energy_usage(
            start=today_start,
            end=today_start + timedelta(hours=2),
        )
        assert len(daily) == 1
        assert daily[0]["is_partial"] is True
    finally:
        src.database.SessionLocal = original_session


def test_moving_avg_daily_usage_returns_empty_for_empty_input():
    """Moving average returns empty list for empty input."""
    result = get_moving_avg_daily_usage([])
    assert result == []


def test_moving_avg_daily_usage_with_single_day():
    """Moving average with single day returns that day's value."""
    daily_data = [{"t": 1000000, "kwh": 10.0}]
    result = get_moving_avg_daily_usage(daily_data, window_days=30)

    assert len(result) == 1
    assert result[0]["t"] == 1000000
    assert result[0]["kwh"] == pytest.approx(10.0)


def test_moving_avg_daily_usage_calculates_average():
    """Moving average correctly calculates average over window."""
    # Create 5 days of data with known values
    daily_data = [{"t": 1000000 + i * 86400000, "kwh": float(i + 1) * 10.0} for i in range(5)]
    # Day 0: 10, Day 1: 20, Day 2: 30, Day 3: 40, Day 4: 50

    result = get_moving_avg_daily_usage(daily_data, window_days=3)

    assert len(result) == 5
    # Day 0: avg(10) = 10
    assert result[0]["kwh"] == pytest.approx(10.0)
    # Day 1: avg(10, 20) = 15
    assert result[1]["kwh"] == pytest.approx(15.0)
    # Day 2: avg(10, 20, 30) = 20
    assert result[2]["kwh"] == pytest.approx(20.0)
    # Day 3: avg(20, 30, 40) = 30 (window of 3)
    assert result[3]["kwh"] == pytest.approx(30.0)
    # Day 4: avg(30, 40, 50) = 40 (window of 3)
    assert result[4]["kwh"] == pytest.approx(40.0)


def test_moving_avg_daily_usage_handles_small_history():
    """Moving average uses available data when history is less than window."""
    # Create 10 days of data
    daily_data = [{"t": 1000000 + i * 86400000, "kwh": 15.0} for i in range(10)]

    # Request 30-day window but only have 10 days
    result = get_moving_avg_daily_usage(daily_data, window_days=30)

    assert len(result) == 10
    # Each day should use all available history up to that point
    # Last day should average all 10 days = 15.0
    assert result[-1]["kwh"] == pytest.approx(15.0)


def test_get_stats_computes_power_aggregates(test_db, sample_readings):
    """Stats calculation includes min/max/avg power and energy delta."""
    start = sample_readings[0]["timestamp"]
    end = sample_readings[-1]["timestamp"]

    # Monkey-patch SessionLocal to use test_db
    import src.database

    original_session = src.database.SessionLocal
    src.database.SessionLocal = test_db

    try:
        stats = get_stats(start=start, end=end)

        assert stats["count"] == len(sample_readings)
        assert stats["min_power_watts"] == pytest.approx(500.0)
        assert stats["max_power_watts"] == pytest.approx(1210.0)
        assert stats["energy_used_kwh"] is not None
        assert stats["energy_used_kwh"] > 0
    finally:
        src.database.SessionLocal = original_session


def test_get_stats_handles_empty_range(test_db):
    """Stats with no data returns zero count and nulls."""
    import src.database

    original_session = src.database.SessionLocal
    src.database.SessionLocal = test_db

    try:
        now = datetime.now(local_timezone())
        future = now + timedelta(days=365)

        stats = get_stats(start=now, end=future)
        assert stats["count"] == 0
        assert stats["energy_used_kwh"] is None
    finally:
        src.database.SessionLocal = original_session
