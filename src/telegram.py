import logging

import requests

import sys

from src.values import TELEGRAM_API_TOKEN
from src.values import TELEGRAM_CHAT_ID


def report_missing_data_to_telegram(message: str) -> None:
    """Send an error message to a Telegram chat."""

    # if running on mac, return
    if sys.platform == "darwin":
        return

    # Truncate full_status if too long - keep the END since errors are usually there
    message = f"""⚠️⚡️*ENERGY MONITOR:*⚡️⚠️ {message}"""

    url = f"https://api.telegram.org/bot{TELEGRAM_API_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "Markdown",
    }

    try:
        response = requests.post(url, data=payload)
        response.raise_for_status()
    except requests.RequestException as exc:
        logging.error("Failed to send message to Telegram: %s", exc)
