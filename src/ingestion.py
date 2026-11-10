"""Ingestion liveness, derived from the age of the newest reading."""

import time
from dataclasses import dataclass
from datetime import timedelta

# Readings arrive roughly every 10s; a minute without one means the feed is broken, not slow.
STALE_AFTER = timedelta(seconds=60)


def now_ms() -> int:
    return int(time.time() * 1000)


def reading_age(last_reading_ms: int | None, at_ms: int) -> timedelta | None:
    """Time from the newest reading to `at_ms`, or None when there has been no reading."""
    if last_reading_ms is None:
        return None
    return timedelta(milliseconds=at_ms - last_reading_ms)


@dataclass(frozen=True)
class IngestionState:
    age: timedelta | None

    @classmethod
    def at(cls, last_reading_ms: int | None, at_ms: int) -> "IngestionState":
        return cls(reading_age(last_reading_ms, at_ms))

    @property
    def age_seconds(self) -> float | None:
        return None if self.age is None else round(self.age.total_seconds(), 1)

    @property
    def is_stale(self) -> bool:
        """The live readout greys out only once the age is past the threshold."""
        return self.age is None or self.age > STALE_AFTER

    @property
    def is_receiving(self) -> bool:
        """`/status` reports healthy only while the age is under the threshold."""
        return self.age is not None and self.age < STALE_AFTER
