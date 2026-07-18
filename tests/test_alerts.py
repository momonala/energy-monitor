"""Tests for Service Monitor alert delivery."""

import io
import json
import urllib.error
from unittest.mock import MagicMock
from unittest.mock import patch

from src.alerts import ALERT_PREFIX
from src.alerts import send_alert


def test_send_alert_posts_markdown_message_to_service_monitor():
    response = MagicMock()
    response.status = 200
    response.__enter__.return_value = response
    response.__exit__.return_value = False

    with patch("src.alerts.sys.platform", "linux"):
        with patch("src.alerts.urllib.request.urlopen", return_value=response) as mock_urlopen:
            with patch("src.alerts.metrics") as mock_metrics:
                send_alert("Hardware device went *offline*")

    request = mock_urlopen.call_args.args[0]
    assert request.full_url == "http://localhost:5001/api/alert"
    assert request.get_method() == "POST"
    assert request.get_header("Content-type") == "application/json"
    assert json.loads(request.data.decode()) == {
        "message": f"{ALERT_PREFIX}Hardware device went *offline*",
    }
    mock_metrics.increment.assert_called_once_with("alerts.send.success")


def test_send_alert_skips_on_darwin():
    with patch("src.alerts.sys.platform", "darwin"):
        with patch("src.alerts.urllib.request.urlopen") as mock_urlopen:
            send_alert("should not send")

    mock_urlopen.assert_not_called()


def test_send_alert_logs_http_errors_without_raising():
    error = urllib.error.HTTPError(
        url="http://localhost:5001/api/alert",
        code=502,
        msg="Bad Gateway",
        hdrs=None,
        fp=io.BytesIO(b'{"ok": false}'),
    )

    with patch("src.alerts.sys.platform", "linux"):
        with patch("src.alerts.urllib.request.urlopen", side_effect=error):
            with patch("src.alerts.logger") as mock_logger:
                with patch("src.alerts.metrics") as mock_metrics:
                    send_alert("low readings")

    mock_logger.error.assert_called_once()
    mock_metrics.increment.assert_called_once_with("alerts.send.errors")


def test_send_alert_logs_connection_errors_without_raising():
    with patch("src.alerts.sys.platform", "linux"):
        with patch(
            "src.alerts.urllib.request.urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            with patch("src.alerts.logger") as mock_logger:
                with patch("src.alerts.metrics") as mock_metrics:
                    send_alert("low readings")

    mock_logger.error.assert_called_once()
    mock_metrics.increment.assert_called_once_with("alerts.send.errors")


def test_send_alert_logs_timeouts_without_raising():
    with patch("src.alerts.sys.platform", "linux"):
        with patch(
            "src.alerts.urllib.request.urlopen",
            side_effect=TimeoutError("timed out"),
        ):
            with patch("src.alerts.logger") as mock_logger:
                with patch("src.alerts.metrics") as mock_metrics:
                    send_alert("low readings")

    mock_logger.error.assert_called_once()
    mock_metrics.increment.assert_called_once_with("alerts.send.errors")
