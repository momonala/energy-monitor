from datetime import datetime
from datetime import timezone
from functools import lru_cache


@lru_cache(maxsize=1)
def local_timezone():
    return datetime.now(timezone.utc).astimezone().tzinfo


def parse_time_param(value: str | None) -> datetime | None:
    """
    Parse a time query parameter. Accepts:
      - milliseconds since epoch (int)
      - ISO-8601 string
    Returns a timezone-aware datetime, or None if the value is empty or unparseable.
    """
    if not value:
        return None
    try:
        ms = int(value)
        return datetime.fromtimestamp(ms / 1000.0, tz=local_timezone())
    except ValueError:
        pass
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=local_timezone())
        return dt
    except ValueError:
        return None
