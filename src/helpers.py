import logging
import time
from datetime import datetime
from datetime import timezone
from functools import lru_cache
from functools import wraps

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def timed(func):
    """Decorator to log function execution time with args."""

    @wraps(func)
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        result = func(*args, **kwargs)
        elapsed_ms = (time.perf_counter() - start) * 1000
        # Format args for logging
        args_str = ", ".join(repr(a) for a in args) if args else ""
        kwargs_str = ", ".join(f"{k}={v!r}" for k, v in kwargs.items()) if kwargs else ""
        params = ", ".join(filter(None, [args_str, kwargs_str])) or "no args"
        logger.debug(f"[{func.__name__}]({params}) completed in {elapsed_ms:.1f}ms")
        return result

    return wrapper


@lru_cache(maxsize=1)
def local_timezone():
    return datetime.now(timezone.utc).astimezone().tzinfo


def parse_time_param(value: str | None):
    """
    Parse a time query parameter. Accepts:
      - milliseconds since epoch (int)
      - ISO-8601 string
    Returns a timezone-aware UTC datetime or None.
    """
    if not value:
        return None
    try:
        # ms since epoch
        ms = int(value)

        return datetime.fromtimestamp(ms / 1000.0, tz=local_timezone())
    except (ValueError, TypeError):
        pass
    try:

        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=local_timezone())
        return dt.astimezone(tz=dt.tzinfo)
    except Exception:
        return None
