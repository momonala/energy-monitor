"""Classify why ingestion stalled, so alerts name a fault domain instead of a symptom.

From the database, every stall looks the same: readings stop. But "the meter dropped off
WiFi" and "this host lost its path to the LAN" need opposite responses, and in Aug 2026 the
second was misread as the first for seven days.

Probing a ladder of hops separates them. The meter joins the router's own WiFi, so the
gateway is the discriminator: a meter that fell off WiFi leaves the gateway reachable,
whereas a host that lost its LAN path cannot reach either.
"""

import json
import subprocess
import urllib.error
import urllib.request
from urllib.parse import urlparse

from src.config import GATEWAY_IP
from src.config import TASMOTA_UI_URL
from src.observability import get_logger

logger = get_logger(__name__)

_PING_TIMEOUT_SECONDS = 2
_HTTP_TIMEOUT_SECONDS = 5
METER_IP = urlparse(TASMOTA_UI_URL).hostname


def _reachable(host: str) -> bool:
    """True if the host answers a single ping. Any failure to probe counts as unreachable.

    `ping -W` is seconds on Linux, where this runs; macOS reads it as milliseconds but
    exits 0 for a late reply anyway, so local runs skew optimistic. The subprocess timeout
    is the real bound either way — this must never hang the scheduler.
    """
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", str(_PING_TIMEOUT_SECONDS), host],
            capture_output=True,
            check=False,
            timeout=_PING_TIMEOUT_SECONDS + 2,
        )
    except (subprocess.SubprocessError, OSError):
        logger.exception("Ping probe failed for %s", host)
        return False
    return result.returncode == 0


def meter_wifi_summary() -> str | None:
    """Summarise the meter's own WiFi counters, or None if it does not answer over HTTP.

    `LinkCount` and `Downtime` distinguish a radio that has been flapping from one that
    never dropped; `Uptime` resets if the device crashed and rebooted.
    """
    url = f"{TASMOTA_UI_URL.rstrip('/')}/cm?cmnd=Status%2011"
    try:
        with urllib.request.urlopen(url, timeout=_HTTP_TIMEOUT_SECONDS) as response:
            payload = json.load(response)["StatusSTS"]
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        logger.warning("Meter did not answer its HTTP status endpoint")
        return None
    wifi = payload.get("Wifi", {})
    return (
        f"uptime {payload.get('Uptime')}, "
        f"wifi reconnects {wifi.get('LinkCount')}, "
        f"wifi downtime {wifi.get('Downtime')}, "
        f"RSSI {wifi.get('Signal')}dBm"
    )


def classify_stall() -> str:
    """Return a one-line diagnosis of why readings stopped, naming the fault domain."""
    if not _reachable(GATEWAY_IP):
        return f"gateway {GATEWAY_IP} unreachable — this host's own network link is down"

    if not _reachable(METER_IP):
        return f"gateway OK, meter {METER_IP} unreachable — meter is offline (power or WiFi range)"

    wifi = meter_wifi_summary()
    if wifi is None:
        return f"all hops ping OK but meter {METER_IP} ignores HTTP — meter is wedged, needs a power cycle"
    return f"network fully reachable and meter healthy ({wifi}) — suspect the broker or ingestion service"
