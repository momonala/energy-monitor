"""Tests for ingestion liveness derived from reading age."""

from datetime import timedelta

import pytest

from src.ingestion import IngestionState
from src.ingestion import reading_age

NOW_MS = 1_700_000_000_000


def test_reading_age_is_none_before_any_reading():
    assert reading_age(None, NOW_MS) is None


def test_reading_age_is_time_since_newest_reading():
    assert reading_age(NOW_MS - 61_500, NOW_MS) == timedelta(milliseconds=61_500)


@pytest.mark.parametrize(
    "age_ms,stale,receiving,age_seconds",
    [
        (0, False, True, 0.0),
        (59_999, False, True, 60.0),
        (60_000, False, False, 60.0),
        (60_001, True, False, 60.0),
        (60_060, True, False, 60.1),
    ],
)
def test_state_at_stale_threshold(age_ms, stale, receiving, age_seconds):
    state = IngestionState.at(NOW_MS - age_ms, NOW_MS)
    assert state.is_stale is stale
    assert state.is_receiving is receiving
    assert state.age_seconds == age_seconds


def test_state_without_any_reading():
    state = IngestionState.at(None, NOW_MS)
    assert state.age is None
    assert state.is_stale is True
    assert state.is_receiving is False
    assert state.age_seconds is None
