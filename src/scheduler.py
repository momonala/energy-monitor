"""Hourly scheduler for database health checks and git backups."""

import time

import schedule

import src.observability  # noqa: F401
from src.database import log_db_health_check
from src.git_tool import commit_db_if_changed
from src.observability import get_logger

logger = get_logger(__name__)


def get_scheduled_jobs():
    """Get the scheduled jobs for logging."""
    return [repr(job) for job in schedule.get_jobs()]


def _run_scheduled_job(job_name: str, fn) -> None:
    """Run a scheduled callback and emit scheduler metrics."""
    fn()


if __name__ == "__main__":
    schedule.every().hour.at(":00").do(_run_scheduled_job, "db_health_check", log_db_health_check)
    logger.info("⏰ Scheduled hourly logging of DB health check")
    schedule.every().hour.at(":00").do(_run_scheduled_job, "db_git_backup", commit_db_if_changed)
    logger.info("⏰ Scheduled hourly commit of DB if changed")
    logger.info(f"⏰ Scheduled jobs: {get_scheduled_jobs()}")

    while True:
        schedule.run_pending()
        time.sleep(30)
