"""Hourly scheduler for database health checks and git backups."""

import logging
import time

import schedule

from src.database import log_db_health_check
from src.git_tool import commit_db_if_changed

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def get_scheduled_jobs():
    """Get the scheduled jobs for logging."""
    return [repr(job) for job in schedule.get_jobs()]


if __name__ == "__main__":
    schedule.every().hour.at(":00").do(log_db_health_check)
    logger.info("⏰ Scheduled hourly logging of DB health check")
    schedule.every().hour.at(":00").do(commit_db_if_changed)
    logger.info("⏰ Scheduled hourly commit of DB if changed")
    logger.info(f"⏰ Scheduled jobs: {get_scheduled_jobs()}")

    while True:
        schedule.run_pending()
        time.sleep(30)
