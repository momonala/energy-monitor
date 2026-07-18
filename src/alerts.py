"""Send alerts via the local Service Monitor API."""

import json
import sys
import urllib.error
import urllib.request

from src.config import SERVICE_MONITOR_URL
from src.observability import get_logger
from src.observability import metrics

logger = get_logger(__name__)

ALERT_PREFIX = "⚠️⚡️*ENERGY MONITOR:*⚡️⚠️ "
_ALERT_TIMEOUT_SECONDS = 10


def send_alert(message: str) -> None:
    """POST a Markdown alert to Service Monitor. Failures are logged, never raised."""
    if sys.platform == "darwin":
        return

    body = json.dumps({"message": f"{ALERT_PREFIX}{message}"}).encode()
    request = urllib.request.Request(
        f"{SERVICE_MONITOR_URL.rstrip('/')}/api/alert",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_ALERT_TIMEOUT_SECONDS) as response:
            if response.status >= 400:
                metrics.increment("alerts.send.errors")
                logger.error("Alert API returned HTTP %s", response.status)
                return
        metrics.increment("alerts.send.success")
    except urllib.error.HTTPError as exc:
        metrics.increment("alerts.send.errors")
        logger.error("Alert API returned HTTP %s: %s", exc.code, exc.reason)
    except TimeoutError:
        metrics.increment("alerts.send.errors")
        logger.error(
            "Alert API timed out after %ss",
            _ALERT_TIMEOUT_SECONDS,
        )
    except urllib.error.URLError as exc:
        metrics.increment("alerts.send.errors")
        logger.error("Failed to send alert via Service Monitor: %s", exc)
    except OSError as exc:
        metrics.increment("alerts.send.errors")
        logger.error("Failed to send alert via Service Monitor: %s", exc)
