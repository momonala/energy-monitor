"""Tests for the month-end Ostrom meter reading submission."""

import email.message
import io
import json
import urllib.error
from datetime import date
from datetime import datetime
from datetime import timedelta
from unittest.mock import patch

import pytest

from src.helpers import local_timezone
from src.ostrom import API_URL
from src.ostrom import OstromClient
from src.ostrom import PlannedReading
from src.ostrom import SubmissionError
from src.ostrom import plan_reading
from src.ostrom import run_scheduled_submission

NOW = datetime(2026, 11, 30, 10, 0, tzinfo=local_timezone())
CONTRACT_ID = 7


def meter(kwh: float | None = 1234.9, age: timedelta = timedelta(minutes=5)) -> dict:
    return {"timestamp_ms": int((NOW - age).timestamp() * 1000), "energy_in_kwh": kwh}


def ostrom_row(read_at: str, value: int = 1000, origin: str = "GRID", qualifier: str = "read") -> dict:
    return {"obis": "1-0:1.8.0", "readAt": read_at, "value": value, "origin": origin, "qualifier": qualifier}


LAST_ACTUAL = ostrom_row("2026-10-26 23:59:59", value=1000, origin="CUSTOMER")


class FakeClient:
    def __init__(self, readings: list[dict] | None = None) -> None:
        self.readings = readings if readings is not None else [LAST_ACTUAL]
        self.submitted: list[PlannedReading] = []

    def active_contract_id(self) -> int:
        return CONTRACT_ID

    def meter_readings(self, contract_id: int) -> list[dict]:
        return self.readings

    def submit_reading(self, reading: PlannedReading) -> None:
        self.submitted.append(reading)


def test_plan_reading_floors_meter_value_for_today():
    assert plan_reading(FakeClient(), meter(1234.9), NOW) == PlannedReading(
        CONTRACT_ID, date(2026, 11, 30), 1234, 1000
    )


@pytest.mark.parametrize(
    ("existing", "expect_plan"),
    [
        (ostrom_row("2026-11-30 23:59:59", origin="CUSTOMER"), False),
        (ostrom_row("2026-11-30 00:00:00", origin="GRID"), True),
        (ostrom_row("2026-11-29 23:59:59", origin="CUSTOMER"), True),
    ],
)
def test_plan_reading_skips_only_when_a_customer_reading_exists_today(existing, expect_plan):
    plan = plan_reading(FakeClient(readings=[existing, LAST_ACTUAL]), meter(), NOW)

    assert (plan is not None) == expect_plan


def test_plan_reading_ignores_estimates_above_the_meter():
    overshooting_estimate = ostrom_row("2026-11-15 00:00:00", value=5000, qualifier="estimated")

    plan = plan_reading(FakeClient(readings=[overshooting_estimate, LAST_ACTUAL]), meter(1234.9), NOW)

    assert plan is not None
    assert plan.previous_kwh == 1000


@pytest.mark.parametrize(
    "meter_reading",
    [None, meter(kwh=None), meter(age=timedelta(hours=2)), meter(kwh=999.5)],
    ids=["no-reading", "no-energy-value", "stale", "below-ostrom-last-actual-reading"],
)
def test_plan_reading_rejects_unusable_meter_data(meter_reading):
    with pytest.raises(SubmissionError):
        plan_reading(FakeClient(), meter_reading, NOW)


def test_scheduled_submission_submits_and_alerts():
    client = FakeClient()

    with (
        patch("src.ostrom.OstromClient", return_value=client),
        patch("src.ostrom.latest_energy_reading", return_value=meter()),
        patch("src.ostrom.send_alert") as mock_alert,
    ):
        run_scheduled_submission(NOW)

    assert [r.value_kwh for r in client.submitted] == [1234]
    assert "submitted" in mock_alert.call_args.args[0]


@pytest.mark.parametrize(
    ("hour", "expected_alert"),
    [(10, "Retrying hourly"), (14, None), (22, "No more retries")],
)
def test_scheduled_submission_alerts_on_first_and_final_failure_only(hour, expected_alert):
    with (
        patch("src.ostrom.OstromClient", side_effect=SubmissionError("refresh returned HTTP 401")),
        patch("src.ostrom.send_alert") as mock_alert,
    ):
        run_scheduled_submission(NOW.replace(hour=hour))

    if expected_alert is None:
        mock_alert.assert_not_called()
    else:
        assert expected_alert in mock_alert.call_args.args[0]


class FakeResponse:
    def __init__(self, payload: object, set_cookies: tuple[str, ...] = ()) -> None:
        self._body = json.dumps(payload).encode()
        self.headers = email.message.Message()
        for cookie in set_cookies:
            self.headers["Set-Cookie"] = cookie

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> bool:
        return False


def test_client_refreshes_then_uses_both_cookies_and_posts_the_reading():
    responses = {
        ("POST", "/auth/refresh"): FakeResponse(
            {"id": 42, "success": True}, ("access_token=new-access; HttpOnly; Path=/",)
        ),
        ("POST", f"/contracts/{CONTRACT_ID}/meter-readings"): FakeResponse({"success": True}),
    }
    sent = []

    def fake_urlopen(request, timeout):
        sent.append(request)
        return responses[(request.get_method(), request.full_url.removeprefix(API_URL))]

    with patch("src.ostrom.urllib.request.urlopen", side_effect=fake_urlopen):
        client = OstromClient("the-refresh-token")
        client.submit_reading(PlannedReading(CONTRACT_ID, date(2026, 11, 30), 1234, 1000))

    refresh, post = sent
    assert client.user_id == 42
    assert refresh.get_header("Cookie") == "refresh_token=the-refresh-token"
    assert refresh.get_header("X-session-token") == "the-refresh-token"
    assert post.get_header("Cookie") == "access_token=new-access; refresh_token=the-refresh-token"
    assert json.loads(post.data) == {
        "readAtDate": "2026-11-30",
        "meterReadings": [{"obis": "1-0:1.8.0", "readingValue": "1234"}],
        "forceInvoice": False,
        "reviewedByUser": False,
        "isInterimInvoice": False,
    }


def test_client_reports_http_status_and_body_on_failure():
    error = urllib.error.HTTPError(
        url=f"{API_URL}/auth/refresh",
        code=401,
        msg="Unauthorized",
        hdrs=None,
        fp=io.BytesIO(b'{"statusCode":401,"message":"Unauthorized"}'),
    )

    with (
        patch("src.ostrom.urllib.request.urlopen", side_effect=error),
        pytest.raises(SubmissionError, match="HTTP 401.*Unauthorized"),
    ):
        OstromClient("expired-token")
