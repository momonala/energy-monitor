"""Submit the month-end meter reading to Ostrom through the API behind its mobile app.

The API is unofficial and was reverse-engineered from the app; see docs/ostrom-api.md.
"""

import json
import math
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC
from datetime import date
from datetime import datetime
from datetime import timedelta

import typer

from src.alerts import send_alert
from src.database import latest_energy_reading
from src.env import OSTROM_REFRESH_TOKEN
from src.observability import get_logger
from src.observability import metrics

logger = get_logger(__name__)

API_URL = "https://api.ostrom.de/v1"
OBIS_ENERGY_IN = "1-0:1.8.0"
FIRST_ATTEMPT_HOUR = 10
LAST_ATTEMPT_HOUR = 22
MAX_READING_AGE = timedelta(hours=1)

_TIMEOUT_SECONDS = 20
_ERROR_BODY_CHARS = 300
_APP_HEADERS = {
    "accept": "application/json",
    "accept-language": "en-GB,en;q=0.9",
    "user-agent": "OstromMobile/1254 CFNetwork/3860.700.2 Darwin/25.6.0",
    "x-app-version": "6.4.0",
}


class SubmissionError(RuntimeError):
    """The reading could not be submitted: bad local data, or an Ostrom call failed."""


@dataclass(frozen=True)
class PlannedReading:
    contract_id: int
    read_date: date
    value_kwh: int
    previous_kwh: int

    def describe(self) -> str:
        delta = self.value_kwh - self.previous_kwh
        return f"{self.value_kwh} kWh for {self.read_date} (+{delta} kWh since Ostrom's last actual reading)"


def _cookie_value(set_cookie_headers: list[str], name: str) -> str | None:
    for header in set_cookie_headers:
        cookie_name, _, rest = header.partition("=")
        if cookie_name.strip() == name:
            return rest.split(";")[0]
    return None


class OstromClient:
    """A logged-in session: refreshes the access token on creation, then reuses it."""

    def __init__(self, refresh_token: str) -> None:
        if not refresh_token:
            raise SubmissionError("OSTROM_REFRESH_TOKEN is not set in .env")
        self._refresh_token = refresh_token
        self._access_token: str | None = None
        self.user_id = self._refresh()

    def _call(self, method: str, path: str, body: dict | None = None) -> tuple[object, list[str]]:
        cookies = f"refresh_token={self._refresh_token}"
        if self._access_token:
            cookies = f"access_token={self._access_token}; {cookies}"
        headers = {**_APP_HEADERS, "cookie": cookies}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["content-type"] = "application/json"
        if path == "/auth/refresh":
            headers["x-session-token"] = self._refresh_token
        request = urllib.request.Request(f"{API_URL}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read())
                set_cookies = response.headers.get_all("Set-Cookie") or []
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:_ERROR_BODY_CHARS]
            raise SubmissionError(f"{method} {path} returned HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise SubmissionError(f"{method} {path} failed: {exc}") from exc
        return payload, set_cookies

    def _refresh(self) -> int:
        payload, set_cookies = self._call("POST", "/auth/refresh", {})
        self._access_token = _cookie_value(set_cookies, "access_token")
        if not self._access_token:
            raise SubmissionError("token refresh succeeded but returned no access_token cookie")
        return payload["id"]

    def active_contract_id(self) -> int:
        payload, _ = self._call("GET", f"/users/{self.user_id}/home-page-info")
        active = [c["id"] for c in payload["contracts"]["electricity"] if c["status"] == "active"]
        if len(active) != 1:
            raise SubmissionError(f"expected one active electricity contract, found {len(active)}")
        return active[0]

    def meter_readings(self, contract_id: int) -> list[dict]:
        payload, _ = self._call("GET", f"/contracts/{contract_id}/meter-readings")
        return payload

    def submit_reading(self, reading: PlannedReading) -> None:
        body = {
            "readAtDate": reading.read_date.isoformat(),
            "meterReadings": [{"obis": OBIS_ENERGY_IN, "readingValue": str(reading.value_kwh)}],
            "forceInvoice": False,
            "reviewedByUser": False,
            "isInterimInvoice": False,
        }
        payload, _ = self._call("POST", f"/contracts/{reading.contract_id}/meter-readings", body)
        if payload.get("success") is not True:
            raise SubmissionError(f"Ostrom did not confirm the reading: {payload}")


def plan_reading(client: OstromClient, meter_reading: dict | None, now: datetime) -> PlannedReading | None:
    """Work out today's reading, or None when a reading for today is already on Ostrom.

    Raises:
        SubmissionError: the meter reading is missing, stale, or lower than Ostrom's last actual reading.
    """
    if meter_reading is None or meter_reading["energy_in_kwh"] is None:
        raise SubmissionError("no meter reading in the database")
    reading_time = datetime.fromtimestamp(meter_reading["timestamp_ms"] / 1000, tz=UTC).astimezone()
    if now - reading_time > MAX_READING_AGE:
        raise SubmissionError(
            f"newest meter reading is from {reading_time:%Y-%m-%d %H:%M}, too old to submit"
        )

    contract_id = client.active_contract_id()
    today = now.date()
    readings = [r for r in client.meter_readings(contract_id) if r["obis"] == OBIS_ENERGY_IN]
    if any(r["origin"] == "CUSTOMER" and r["readAt"].startswith(today.isoformat()) for r in readings):
        return None

    value_kwh = math.floor(meter_reading["energy_in_kwh"])
    actual = [r for r in readings if r["qualifier"] == "read"]
    previous_kwh = max(actual, key=lambda r: r["readAt"])["value"] if actual else 0
    if value_kwh < previous_kwh:
        raise SubmissionError(
            f"meter reads {value_kwh} kWh, below Ostrom's last actual reading of {previous_kwh} kWh"
        )
    return PlannedReading(contract_id, today, value_kwh, previous_kwh)


def run_scheduled_submission(now: datetime) -> None:
    """Submit the month-end reading. Runs hourly through the last day; alerts on the first and final failure."""
    try:
        client = OstromClient(OSTROM_REFRESH_TOKEN)
        reading = plan_reading(client, latest_energy_reading(), now)
        if reading is None:
            logger.info("Ostrom already has a reading for %s", now.date())
            return
        client.submit_reading(reading)
    except Exception as exc:
        metrics.increment("ostrom.submit.errors")
        logger.exception("Ostrom meter reading submission failed")
        if now.hour == FIRST_ATTEMPT_HOUR:
            send_alert(f"Ostrom meter reading failed: `{exc}`\nRetrying hourly until {LAST_ATTEMPT_HOUR}:00.")
        elif now.hour >= LAST_ATTEMPT_HOUR:
            send_alert(f"Ostrom meter reading failed: `{exc}`\nNo more retries; submit it in the Ostrom app.")
        return
    metrics.increment("ostrom.submit.success")
    logger.info("Submitted Ostrom meter reading: %s", reading.describe())
    send_alert(f"Ostrom meter reading submitted: {reading.describe()}")


def ostrom_cli(
    submit: bool = typer.Option(False, "--submit", help="POST the reading. Without it, nothing is sent."),
) -> None:
    """Plan today's meter reading against the live Ostrom API, and submit it with --submit."""
    now = datetime.now().astimezone()
    client = OstromClient(OSTROM_REFRESH_TOKEN)
    reading = plan_reading(client, latest_energy_reading(), now)
    if reading is None:
        typer.echo(f"Ostrom already has a reading for {now.date()}; nothing to do.")
        return
    typer.echo(f"Planned: {reading.describe()}")
    if not submit:
        typer.echo("Dry run; pass --submit to send it.")
        return
    client.submit_reading(reading)
    typer.echo("Submitted.")


def main():
    typer.run(ostrom_cli)


if __name__ == "__main__":
    main()
