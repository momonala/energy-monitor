import logging
import re
import subprocess
from datetime import datetime

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

FILE_TO_COMMIT = "data/energy.db"
BRANCH = "main"
COMMIT_PREFIX = "[DB-AUTO-BACKUP]"
DATETIME_FORMAT = "%Y-%m-%dT%H:%M:%S"
RANGE_RE = re.compile(
    r"(?P<start>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})-" r"(?P<end>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})"
)


def run_command(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error("Command %s failed: %s", cmd, result.stderr.strip())
        raise subprocess.CalledProcessError(result.returncode, cmd, result.stdout, result.stderr)
    return result.stdout.strip()


def format_datetime(value: datetime) -> str:
    return value.strftime(DATETIME_FORMAT)


def parse_start_from_commit(message: str) -> str | None:
    """Return the start timestamp if the commit matches the auto-backup pattern."""
    match = RANGE_RE.search(message)
    if match:
        return match.group("start")
    return None


def commit_db_if_changed():
    diff = run_command(["git", "diff", FILE_TO_COMMIT])
    if not diff:
        logger.info("No changes. Skipping commit.")
        return

    run_command(["git", "add", FILE_TO_COMMIT])
    now_str = format_datetime(datetime.now())
    last_commit_msg = ""
    start_time = now_str
    should_amend = False

    try:
        last_commit_msg = run_command(["git", "log", "-1", "--pretty=%s"])
    except subprocess.CalledProcessError:
        logger.info("Unable to read last commit; creating a new backup commit.")

    if last_commit_msg.startswith(COMMIT_PREFIX):
        possible_start = parse_start_from_commit(last_commit_msg)
        if possible_start:
            start_time = possible_start
            should_amend = True

    commit_message = f"{COMMIT_PREFIX} {start_time}-{now_str}"
    if should_amend:
        run_command(["git", "commit", "--amend", "-m", commit_message])
        push_args = ["git", "push", "--force", "origin", BRANCH]
        log_action = f"Changes amended to auto-backup commit with bounds {start_time}-{now_str}."
    else:
        run_command(["git", "commit", "-m", commit_message])
        push_args = ["git", "push", "origin", BRANCH]
        log_action = f"New auto-backup commit created with bounds {start_time}-{now_str}."

    run_command(push_args)
    run_command(["cp", FILE_TO_COMMIT, f"{FILE_TO_COMMIT}.bk"])
    logger.info(log_action)
