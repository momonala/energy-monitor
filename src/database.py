import json
import logging
from datetime import datetime
from datetime import timedelta
from functools import lru_cache

import sqlalchemy
from sqlalchemy import Column
from sqlalchemy import DateTime
from sqlalchemy import Float
from sqlalchemy import String
from sqlalchemy import Text
from sqlalchemy import create_engine
from sqlalchemy import event
from sqlalchemy import func
from sqlalchemy import text
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker

from src.config import DATABASE_URL
from src.helpers import local_timezone
from src.helpers import timed
from src.telegram import report_missing_data_to_telegram

logger = logging.getLogger(__name__)


class NegativeEnergyError(ValueError):
    """Raised when cumulative energy difference is negative (meter reset or bad data)."""


# Time constants for data queries
DEFAULT_LOOKBACK_WEEKS = 52
YEARLY_AVG_DAYS = 365

# Configure engine with timeout and connection pool settings for better concurrency
engine = create_engine(
    DATABASE_URL,
    future=True,
    connect_args={
        "timeout": 20.0,  # Wait up to 20 seconds for lock to be released
        "check_same_thread": False,  # Allow multi-threaded access
    },
    pool_pre_ping=True,  # Verify connections before using
    pool_recycle=3600,  # Recycle connections after 1 hour
)


@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_conn, connection_record):
    """Enable WAL mode for better concurrency."""
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")  # Faster than FULL, still safe
    cursor.execute("PRAGMA busy_timeout=20000")  # 20 second timeout
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


class EnergyReading(Base):
    __tablename__ = "energy_readings"

    timestamp = Column(
        DateTime,
        default=datetime.now(local_timezone()),
        nullable=False,
        index=True,
        primary_key=True,
    )
    meter_id = Column(String(255), nullable=True, index=True)
    power_watts = Column(Float, nullable=True)
    energy_in_kwh = Column(Float, nullable=True)
    energy_out_kwh = Column(Float, nullable=True)
    power_phase_1_watts = Column(Float, nullable=True)
    power_phase_2_watts = Column(Float, nullable=True)
    power_phase_3_watts = Column(Float, nullable=True)
    raw_payload = Column(Text, nullable=False)

    def __repr__(self):
        return f"EnergyReading(\
        timestamp={self.timestamp}, \
        meter_id={self.meter_id}, \
        power_watts={self.power_watts}, \
        energy_in_kwh={self.energy_in_kwh}, \
        energy_out_kwh={self.energy_out_kwh}, \
        power_phase_1_watts={self.power_phase_1_watts}, \
        power_phase_2_watts={self.power_phase_2_watts}, \
        power_phase_3_watts={self.power_phase_3_watts}, \
        raw_payload={self.raw_payload})"


def init_db():
    """Create all tables if they do not exist and enable WAL mode."""
    # Ensure WAL mode is enabled (the event listener handles this for new connections,
    # but we also set it explicitly here for existing databases)
    with engine.connect() as conn:
        conn.execute(text("PRAGMA journal_mode=WAL"))
        conn.execute(text("PRAGMA synchronous=NORMAL"))
        conn.execute(text("PRAGMA busy_timeout=20000"))
        conn.commit()

    Base.metadata.create_all(bind=engine)
    logger.info("Created all tables")


def _nullable_float(val, *, treat_zero_as_none: bool = False):
    """Return float or None. If treat_zero_as_none and value is 0, return None (for cumulative meters)."""
    if val is None:
        return None
    f = float(val)
    if treat_zero_as_none and f == 0:
        return None
    return f


def save_energy_reading(tasmota_payload: str):
    """Persist a single MT681 energy reading payload."""
    mt_payload = tasmota_payload["MT681"]
    timestamp = datetime.now(local_timezone())
    # Store 0 as NULL: cumulative E_in/E_out should not go to 0 after being high (meter reset/glitch).
    energy_in = _nullable_float(mt_payload.get("E_in"), treat_zero_as_none=True)
    energy_out = _nullable_float(mt_payload.get("E_out"), treat_zero_as_none=True)
    reading = EnergyReading(
        meter_id=str(mt_payload.get("Meter_id")),
        power_watts=float(mt_payload.get("Power")),
        energy_in_kwh=energy_in,
        energy_out_kwh=energy_out,
        power_phase_1_watts=float(mt_payload.get("Power_p1")),
        power_phase_2_watts=float(mt_payload.get("Power_p2")),
        power_phase_3_watts=float(mt_payload.get("Power_p3")),
        timestamp=timestamp,
        raw_payload=json.dumps(mt_payload),
    )

    try:
        with SessionLocal() as session:
            session.add(reading)
            session.commit()
            session.refresh(reading)
        logger.debug(f"🟢 Saved {reading=}")
        return
    except sqlalchemy.exc.IntegrityError:
        logger.info(f"⚠️ Reading already exists for {timestamp=}")
        return


def latest_energy_reading() -> EnergyReading | None:
    """Get the latest energy reading."""
    with SessionLocal() as session:
        last_reading = session.query(EnergyReading).order_by(EnergyReading.timestamp.desc()).first()
        last_reading = last_reading.__dict__
        last_reading.pop("_sa_instance_state")
        last_reading["timestamp"] = last_reading["timestamp"].isoformat()
        return last_reading


def get_monthly_avg_daily_usage() -> float:
    """
    Calculate average daily energy usage over the last ~365 days.
    Uses the latest reading and the oldest reading within the past year.
    If you have less than a year of data (e.g. 4 months), uses that span.
    Returns kWh/day.
    """
    tz = local_timezone()
    now = datetime.now(tz)
    year_ago = now - timedelta(days=YEARLY_AVG_DAYS)

    with SessionLocal() as session:
        latest = session.query(EnergyReading).order_by(EnergyReading.timestamp.desc()).first()
        oldest_in_window = (
            session.query(EnergyReading)
            .filter(EnergyReading.timestamp >= year_ago)
            .order_by(EnergyReading.timestamp.asc())
            .first()
        )

        if not latest or not oldest_in_window:
            raise ValueError("Not enough data")
        if latest.energy_in_kwh is None or oldest_in_window.energy_in_kwh is None:
            raise ValueError("Missing energy data")

        energy_diff = latest.energy_in_kwh - oldest_in_window.energy_in_kwh
        days_diff = (latest.timestamp - oldest_in_window.timestamp).total_seconds() / 86400
        if days_diff <= 0:
            raise ValueError("Invalid time span")
        return energy_diff / days_diff


def num_energy_readings_last_hour() -> int:
    """Get the number of energy readings in the last hour."""
    with SessionLocal() as session:
        return (
            session.query(EnergyReading)
            .filter(EnergyReading.timestamp >= datetime.now(local_timezone()) - timedelta(hours=1))
            .count()
        )


def num_total_energy_readings() -> int:
    """Get the total number of energy readings."""
    with SessionLocal() as session:
        return session.query(EnergyReading).count()


def log_db_health_check():
    """Log the number of records in the DB as a health check."""
    num_readings_last_hour = num_energy_readings_last_hour()
    if num_readings_last_hour < 300:
        report_missing_data_to_telegram(f"Only {num_readings_last_hour} readings in the last hour")
    num_total_readings = num_total_energy_readings()
    logger.info(f"[log_db_health_check] {num_readings_last_hour=} {num_total_readings=}")


@lru_cache(maxsize=1000)
@timed
def get_readings(
    start: datetime | None = datetime.now(local_timezone()) - timedelta(weeks=52),
    end: datetime | None = datetime.now(local_timezone()),
) -> list[dict]:
    """
    Fetch readings in 2-min buckets (max per bucket). Optionally filter by time range.
    Returns a list of dicts with timestamp (ms since epoch), power_watts, and energy_in_kwh.
    Aggregation is done in SQL so we never load full raw rows for large ranges.
    """
    tz = local_timezone()
    start_bound = start.astimezone(tz) if start is not None else datetime.now(tz) - timedelta(weeks=52)
    end_bound = end.astimezone(tz) if end is not None else datetime.now(tz)

    bucket = func.strftime("%s", EnergyReading.timestamp) / 120
    with SessionLocal() as session:
        rows = (
            session.query(
                func.max(EnergyReading.timestamp).label("timestamp"),
                func.max(EnergyReading.power_watts).label("power_watts"),
                func.max(EnergyReading.energy_in_kwh).label("energy_in_kwh"),
            )
            .filter(
                EnergyReading.timestamp >= start_bound,
                EnergyReading.timestamp <= end_bound,
            )
            .group_by(bucket)
            .order_by(func.max(EnergyReading.timestamp))
            .all()
        )

    if rows:
        logger.debug(
            f"[get_readings] Found {len(rows)} 2-min buckets for {start=} {end=}: "
            f"oldest {rows[0][0]}, latest {rows[-1][0]}"
        )
    result: list[dict] = []
    for r in rows:
        ts = int(r.timestamp.timestamp() * 1000)
        result.append(
            {
                "t": ts,
                "p": r.power_watts,
                "e": r.energy_in_kwh,
            }
        )
    return result


def get_daily_energy_usage(
    start: datetime | None = None,
    end: datetime | None = None,
) -> list[dict]:
    """
    Calculate daily energy consumption from the database using SQL.
    Returns list of {t: timestamp_ms, kwh: float, is_partial: bool} per day.
    Partial days are those with less than 23 hours of coverage.
    """
    tz = local_timezone()
    now = datetime.now(tz)
    start_bound = start.astimezone(tz) if start is not None else now - timedelta(weeks=DEFAULT_LOOKBACK_WEEKS)
    end_bound = end.astimezone(tz) if end is not None else now

    sql = text(
        """
    WITH filtered AS (
        SELECT timestamp, energy_in_kwh, date(timestamp) AS d
        FROM energy_readings
        WHERE timestamp >= :start_bound AND timestamp <= :end_bound
          AND energy_in_kwh IS NOT NULL AND energy_in_kwh > 0
    ),
    ranked AS (
        SELECT *,
            row_number() OVER (PARTITION BY d ORDER BY timestamp ASC) AS rn_asc,
            row_number() OVER (PARTITION BY d ORDER BY timestamp DESC) AS rn_desc
        FROM filtered
    )
    SELECT d,
        min(CASE WHEN rn_asc = 1 THEN timestamp END) AS first_ts,
        max(CASE WHEN rn_desc = 1 THEN timestamp END) AS last_ts,
        min(CASE WHEN rn_asc = 1 THEN energy_in_kwh END) AS first_energy,
        max(CASE WHEN rn_desc = 1 THEN energy_in_kwh END) AS last_energy
    FROM ranked
    GROUP BY d
    HAVING first_ts IS NOT NULL AND last_ts IS NOT NULL AND first_energy IS NOT NULL AND last_energy IS NOT NULL
    ORDER BY d
    """
    )

    with SessionLocal() as session:
        rows = session.execute(
            sql,
            {"start_bound": start_bound, "end_bound": end_bound},
        ).fetchall()

    result = []
    for row in rows:
        d_str, first_ts, last_ts, first_energy, last_energy = row
        if first_energy is None or last_energy is None:
            continue
        daily_kwh = float(last_energy) - float(first_energy)
        if daily_kwh < 0:
            raise NegativeEnergyError(
                f"Negative daily energy kwh={daily_kwh} for date={d_str}. "
                f"first_energy={first_energy} last_energy={last_energy}. "
                "Cumulative meter may have reset or data is out of order."
            )

        # SQLite may return timestamp as str; parse to datetime for subtraction
        if isinstance(first_ts, str):
            first_ts = datetime.fromisoformat(first_ts.replace("Z", "+00:00"))
        if isinstance(last_ts, str):
            last_ts = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
        if first_ts.tzinfo is None:
            first_ts = first_ts.replace(tzinfo=tz)
        if last_ts.tzinfo is None:
            last_ts = last_ts.replace(tzinfo=tz)

        hours_covered = (last_ts - first_ts).total_seconds() / 3600
        is_partial = hours_covered < 23

        # Midpoint of day in local timezone (noon)
        date_part = first_ts.date()
        midpoint = datetime.combine(date_part, datetime.min.time().replace(hour=12))
        midpoint = midpoint.replace(tzinfo=tz)
        t_ms = int(midpoint.timestamp() * 1000)

        result.append({"t": t_ms, "kwh": float(daily_kwh), "is_partial": is_partial})

    return result


def get_moving_avg_daily_usage(daily_energy_data: list[dict], window_days: int = 30) -> list[dict]:
    """
    Calculate 30-day moving average of daily energy consumption.
    For each day, returns the average kWh consumption of the preceding window_days
    (or fewer days if less history is available).
    """
    if not daily_energy_data:
        return []

    # Sort by timestamp
    sorted_data = sorted(daily_energy_data, key=lambda x: x["t"])

    result = []
    for i, day in enumerate(sorted_data):
        # Get up to window_days of history (including current day)
        start_idx = max(0, i - window_days + 1)
        window_data = sorted_data[start_idx : i + 1]

        # Calculate average kWh for this window
        kwh_values = [d["kwh"] for d in window_data]
        avg_kwh = sum(kwh_values) / len(kwh_values) if kwh_values else 0.0

        result.append(
            {
                "t": day["t"],
                "kwh": float(avg_kwh),
            }
        )

    return result


def get_stats(start: datetime, end: datetime) -> dict:
    """
    Compute stats between [start, end]:
      - energy_used_kwh: difference in cumulative energy_in_kwh between first>=start and last<=end
      - min_power_watts, max_power_watts, avg_power_watts
      - count
    """
    with SessionLocal() as session:
        # First and last within window
        first_row = (
            session.query(EnergyReading)
            .filter(EnergyReading.timestamp >= start, EnergyReading.timestamp <= end)
            .order_by(EnergyReading.timestamp.asc())
            .first()
        )
        last_row = (
            session.query(EnergyReading)
            .filter(EnergyReading.timestamp >= start, EnergyReading.timestamp <= end)
            .order_by(EnergyReading.timestamp.desc())
            .first()
        )

        agg = (
            session.query(
                func.min(EnergyReading.power_watts),
                func.max(EnergyReading.power_watts),
                func.avg(EnergyReading.power_watts),
                func.count(EnergyReading.power_watts),
            )
            .filter(EnergyReading.timestamp >= start, EnergyReading.timestamp <= end)
            .one()
        )

    min_power, max_power, avg_power, count = agg
    logger.debug(f"⚠️ [get_stats] {min_power=} {max_power=} {avg_power=} {count=}")
    energy_used = None
    if first_row is not None and last_row is not None:
        if first_row.energy_in_kwh is not None and last_row.energy_in_kwh is not None:
            energy_used = float(last_row.energy_in_kwh) - float(first_row.energy_in_kwh)
            if energy_used < 0:
                raise NegativeEnergyError(
                    f"Negative energy_used_kwh={energy_used:.4f} in window start={start!s} end={end!s}. "
                    f"First reading: ts={first_row.timestamp!s} energy_in_kwh={first_row.energy_in_kwh}. "
                    f"Last reading: ts={last_row.timestamp!s} energy_in_kwh={last_row.energy_in_kwh}. "
                    "Cumulative meter may have reset or data is out of order."
                )

    return {
        "energy_used_kwh": energy_used,
        "min_power_watts": float(min_power) if min_power is not None else None,
        "max_power_watts": float(max_power) if max_power is not None else None,
        "avg_power_watts": float(avg_power) if avg_power is not None else None,
        "count": int(count) if count is not None else 0,
    }


if __name__ == "__main__":
    init_db()
