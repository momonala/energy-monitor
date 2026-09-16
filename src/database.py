import os
import time
from datetime import datetime
from datetime import timedelta

import sqlalchemy
from sqlalchemy import BigInteger
from sqlalchemy import Column
from sqlalchemy import Float
from sqlalchemy import String
from sqlalchemy import create_engine
from sqlalchemy import event
from sqlalchemy import func
from sqlalchemy import text
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker

from src.alerts import send_alert
from src.config import DATABASE_PATH
from src.config import DATABASE_URL
from src.diagnostics import classify_stall
from src.helpers import local_timezone
from src.observability import get_logger
from src.observability import metrics

logger = get_logger(__name__)

MS_PER_HOUR = 3_600_000
MS_PER_DAY = 86_400_000


def _now_ms() -> int:
    return int(time.time() * 1000)


def _to_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


class NegativeEnergyError(ValueError):
    """Raised when cumulative energy difference is negative (meter reset or bad data)."""


DEFAULT_LOOKBACK_WEEKS = 52
YEARLY_AVG_DAYS = 365

# Readings arrive roughly every 10s; a minute without one means the feed is broken, not slow.
LIVE_POWER_STALE_SECONDS = 60

engine = create_engine(
    DATABASE_URL,
    future=True,
    connect_args={
        "timeout": 20.0,  # seconds to wait for a locked database
        "check_same_thread": False,
    },
    pool_pre_ping=True,
    pool_recycle=3600,
)


@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_conn, connection_record):
    """Enable WAL mode for better concurrency."""
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA busy_timeout=20000")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


class EnergyReading(Base):
    __tablename__ = "energy_readings"

    # UTC milliseconds since epoch
    timestamp_ms = Column(BigInteger, default=_now_ms, nullable=False, primary_key=True)
    meter_id = Column(String(255), nullable=True)
    power_watts = Column(Float, nullable=True)
    energy_in_kwh = Column(Float, nullable=True)
    energy_out_kwh = Column(Float, nullable=True)
    power_phase_1_watts = Column(Float, nullable=True)
    power_phase_2_watts = Column(Float, nullable=True)
    power_phase_3_watts = Column(Float, nullable=True)

    def __repr__(self):
        return (
            f"EnergyReading(timestamp_ms={self.timestamp_ms}, meter_id={self.meter_id}, "
            f"power_watts={self.power_watts}, energy_in_kwh={self.energy_in_kwh}, "
            f"energy_out_kwh={self.energy_out_kwh})"
        )


def init_db():
    """Create all tables if they do not exist and enable WAL mode."""
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


def _first_present(payload: dict, *keys: str):
    """Return the first non-None value for the given keys."""
    for key in keys:
        value = payload.get(key)
        if value is not None:
            return value
    return None


def _normalize_mt681_payload(mt_payload: dict) -> dict:
    """Map MT681 fields from Tasmota payloads (supports multiple firmware variants)."""
    meter_id = _first_present(mt_payload, "Meter_id", "server_id")
    return {
        "meter_id": str(meter_id) if meter_id is not None else None,
        "power_watts": _nullable_float(_first_present(mt_payload, "Power")),
        "energy_in_kwh": _nullable_float(
            _first_present(mt_payload, "E_in", "ImportActive"),
            treat_zero_as_none=True,
        ),
        "energy_out_kwh": _nullable_float(
            _first_present(mt_payload, "E_out", "ExportActive"),
            treat_zero_as_none=True,
        ),
        "power_phase_1_watts": _nullable_float(_first_present(mt_payload, "Power_p1", "power_L1")),
        "power_phase_2_watts": _nullable_float(_first_present(mt_payload, "Power_p2", "power_L2")),
        "power_phase_3_watts": _nullable_float(_first_present(mt_payload, "Power_p3", "power_L3")),
    }


def format_mt681_summary(mt_payload: dict) -> str:
    """Format normalized MT681 fields for logging."""
    fields = _normalize_mt681_payload(mt_payload)
    return (
        f"meter_id={fields['meter_id']} "
        f"power={fields['power_watts']}W "
        f"E_in={fields['energy_in_kwh']} "
        f"E_out={fields['energy_out_kwh']}"
    )


def save_energy_reading(tasmota_payload: dict):
    """Persist a single MT681 energy reading payload."""
    mt_payload = tasmota_payload["MT681"]
    fields = _normalize_mt681_payload(mt_payload)
    timestamp_ms = _now_ms()
    reading = EnergyReading(
        meter_id=fields["meter_id"],
        power_watts=fields["power_watts"],
        energy_in_kwh=fields["energy_in_kwh"],
        energy_out_kwh=fields["energy_out_kwh"],
        power_phase_1_watts=fields["power_phase_1_watts"],
        power_phase_2_watts=fields["power_phase_2_watts"],
        power_phase_3_watts=fields["power_phase_3_watts"],
        timestamp_ms=timestamp_ms,
    )

    try:
        with metrics.timed("db.save_reading"):
            with SessionLocal() as session:
                session.add(reading)
                session.commit()
                session.refresh(reading)
        metrics.increment("db.readings.saved")
        logger.debug(
            "Saved energy reading: meter_id=%s power=%sW E_in=%s E_out=%s timestamp_ms=%s",
            reading.meter_id,
            reading.power_watts,
            reading.energy_in_kwh,
            reading.energy_out_kwh,
            timestamp_ms,
        )
    except sqlalchemy.exc.IntegrityError:
        metrics.increment("db.readings.duplicate")
        logger.warning(f"Reading already exists for {timestamp_ms=}")


def latest_energy_reading() -> dict | None:
    """Get the latest energy reading as a plain dict, or None if the DB is empty."""
    with SessionLocal() as session:
        reading = session.query(EnergyReading).order_by(EnergyReading.timestamp_ms.desc()).first()
        if reading is None:
            return None
        fields = dict(reading.__dict__)
        fields.pop("_sa_instance_state")
        fields["timestamp"] = datetime.fromtimestamp(
            fields["timestamp_ms"] / 1000, tz=local_timezone()
        ).isoformat()
        return fields


def latest_power() -> dict:
    """
    Get the most recent instantaneous power draw, for the live readout.

    Selects only the two needed columns since this is polled every few seconds. Returns
    nulls rather than raising on an empty DB so the client has a single code path.
    """
    with SessionLocal() as session:
        row = (
            session.query(EnergyReading.timestamp_ms, EnergyReading.power_watts)
            .order_by(EnergyReading.timestamp_ms.desc())
            .first()
        )
    if row is None:
        return {"t": None, "w": None, "age_s": None, "stale": True}

    age_s = (_now_ms() - row.timestamp_ms) / 1000
    return {
        "t": row.timestamp_ms,
        "w": row.power_watts,
        "age_s": round(age_s, 1),
        "stale": age_s > LIVE_POWER_STALE_SECONDS,
    }


def get_monthly_avg_daily_usage() -> float:
    """
    Calculate average daily energy usage over the last ~365 days.
    Uses the latest reading and the oldest reading within the past year.
    If you have less than a year of data (e.g. 4 months), uses that span.
    Returns kWh/day.
    """
    year_ago_ms = _now_ms() - YEARLY_AVG_DAYS * MS_PER_DAY

    with SessionLocal() as session:
        latest = session.query(EnergyReading).order_by(EnergyReading.timestamp_ms.desc()).first()
        oldest_in_window = (
            session.query(EnergyReading)
            .filter(EnergyReading.timestamp_ms >= year_ago_ms)
            .order_by(EnergyReading.timestamp_ms.asc())
            .first()
        )

        if not latest or not oldest_in_window:
            raise ValueError("Not enough data")
        if latest.energy_in_kwh is None or oldest_in_window.energy_in_kwh is None:
            raise ValueError("Missing energy data")

        energy_diff = latest.energy_in_kwh - oldest_in_window.energy_in_kwh
        days_diff = (latest.timestamp_ms - oldest_in_window.timestamp_ms) / MS_PER_DAY
        if days_diff <= 0:
            raise ValueError("Invalid time span")
        return energy_diff / days_diff


def num_energy_readings_last_hour() -> int:
    """Get the number of energy readings in the last hour."""
    with SessionLocal() as session:
        return (
            session.query(EnergyReading).filter(EnergyReading.timestamp_ms >= _now_ms() - MS_PER_HOUR).count()
        )


def num_total_energy_readings() -> int:
    """Get the total number of energy readings."""
    with SessionLocal() as session:
        return session.query(EnergyReading).count()


def time_since_last_reading() -> timedelta | None:
    """Get the time elapsed since the most recent energy reading, or None if the DB is empty."""
    with SessionLocal() as session:
        last_ms = session.query(func.max(EnergyReading.timestamp_ms)).scalar()
    if last_ms is None:
        return None
    return timedelta(milliseconds=_now_ms() - last_ms)


def _format_timedelta(td: timedelta) -> str:
    total_minutes = int(td.total_seconds() // 60)
    hours, minutes = divmod(total_minutes, 60)
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


# Minutes of silence at which to alert, then once a day for as long as it lasts. The first
# is the blip filter: readings arrive every ~10s, so 2 minutes of nothing is a real fault,
# while a brief WiFi drop resolves before it trips.
STALL_ALERT_MINUTES = (2, 15, 60, 360, 1440)
STALL_REPEAT_MINUTES = 1440


def stall_alert_due(gap: timedelta, tick: timedelta) -> bool:
    """True only on the tick where the outage crosses an escalation threshold.

    Alerting on a *crossing* rather than a band means each threshold fires exactly once, so
    this needs no memory of what it already sent — which matters because the alerter must
    survive a service restart mid-outage without resetting its cadence, and because nothing
    is shared between the Flask and MQTT processes anyway.
    """
    now_minutes = gap.total_seconds() / 60
    previous_minutes = now_minutes - tick.total_seconds() / 60
    thresholds = set(STALL_ALERT_MINUTES)
    if now_minutes >= STALL_REPEAT_MINUTES:
        thresholds.add(int(now_minutes // STALL_REPEAT_MINUTES) * STALL_REPEAT_MINUTES)
    return any(previous_minutes < threshold <= now_minutes for threshold in thresholds)


def check_ingestion_stall(tick: timedelta) -> None:
    """Sole owner of stall alerting: detect silence, diagnose it, and escalate on a schedule.

    `tick` is how often the caller runs this, and defines the window a threshold crossing is
    detected in. Diagnosis probes the network, so it only runs on a crossing, never per tick.
    """
    gap = time_since_last_reading()
    if gap is None:
        return
    metrics.gauge("db.ingestion.gap_seconds", gap.total_seconds())
    if not stall_alert_due(gap, tick):
        return
    metrics.increment("db.health.stalled")
    logger.warning("[stall] no readings for %s, diagnosing", _format_timedelta(gap))
    send_alert(f"No readings for `{_format_timedelta(gap)}`\n{classify_stall()}")


def log_db_health_check():
    """Record DB size and volume metrics. Stall alerting belongs to check_ingestion_stall."""
    num_readings_last_hour = num_energy_readings_last_hour()
    metrics.gauge("db.readings.last_hour", num_readings_last_hour)
    if num_readings_last_hour < 300:
        metrics.increment("db.health.low_readings")
    num_total_readings = num_total_energy_readings()
    metrics.gauge("db.readings.total", num_total_readings)
    db_size_mb = os.path.getsize(DATABASE_PATH) / (1024 * 1024)
    metrics.gauge("db.size_mb", db_size_mb)
    logger.debug(f"{num_readings_last_hour=} {num_total_readings=} {db_size_mb=:.1f}")


DEFAULT_READINGS_BUCKET_MS = 120_000
RAW_READING_INTERVAL_MS = 10_000  # sensor TelePeriod; buckets at or below this are raw rows
MAX_READINGS_BUCKET_MS = MS_PER_DAY


def get_readings(
    start: datetime | None = None,
    end: datetime | None = None,
    bucket_ms: int = DEFAULT_READINGS_BUCKET_MS,
) -> list[dict]:
    """
    Fetch readings, optionally filtered by time range, downsampled in SQL to
    bucket_ms buckets (max per bucket) so full raw rows never materialize for
    large ranges. A bucket_ms at or below the raw ~10s cadence returns raw rows.
    Returns a list of dicts with timestamp (ms since epoch), power_watts, and energy_in_kwh.
    """
    start_ms = _to_ms(start) if start is not None else _now_ms() - DEFAULT_LOOKBACK_WEEKS * 7 * MS_PER_DAY
    end_ms = _to_ms(end) if end is not None else _now_ms()
    time_filter = (
        EnergyReading.timestamp_ms >= start_ms,
        EnergyReading.timestamp_ms <= end_ms,
    )
    with metrics.timed("db.get_readings"):
        with SessionLocal() as session:
            if bucket_ms <= RAW_READING_INTERVAL_MS:
                rows = (
                    session.query(
                        EnergyReading.timestamp_ms,
                        EnergyReading.power_watts,
                        EnergyReading.energy_in_kwh,
                    )
                    .filter(*time_filter)
                    .order_by(EnergyReading.timestamp_ms)
                    .all()
                )
            else:
                bucket = EnergyReading.timestamp_ms // bucket_ms
                rows = (
                    session.query(
                        func.max(EnergyReading.timestamp_ms).label("timestamp_ms"),
                        func.max(EnergyReading.power_watts).label("power_watts"),
                        func.max(EnergyReading.energy_in_kwh).label("energy_in_kwh"),
                    )
                    .filter(*time_filter)
                    .group_by(bucket)
                    .order_by(func.max(EnergyReading.timestamp_ms))
                    .all()
                )

    if rows:
        logger.debug(
            f"[get_readings] Found {len(rows)} rows ({bucket_ms=}) for {start_ms=} {end_ms=}: "
            f"oldest {rows[0][0]}, latest {rows[-1][0]}"
        )
    return [{"t": r.timestamp_ms, "p": r.power_watts, "e": r.energy_in_kwh} for r in rows]


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
    start_ms = _to_ms(start) if start is not None else _now_ms() - DEFAULT_LOOKBACK_WEEKS * 7 * MS_PER_DAY
    end_ms = _to_ms(end) if end is not None else _now_ms()

    sql = text("""
    WITH filtered AS (
        SELECT timestamp_ms, energy_in_kwh, date(timestamp_ms / 1000, 'unixepoch', 'localtime') AS d
        FROM energy_readings
        WHERE timestamp_ms >= :start_ms AND timestamp_ms <= :end_ms
          AND energy_in_kwh IS NOT NULL AND energy_in_kwh > 0
    ),
    ranked AS (
        SELECT *,
            row_number() OVER (PARTITION BY d ORDER BY timestamp_ms ASC) AS rn_asc,
            row_number() OVER (PARTITION BY d ORDER BY timestamp_ms DESC) AS rn_desc
        FROM filtered
    )
    SELECT d,
        min(CASE WHEN rn_asc = 1 THEN timestamp_ms END) AS first_ms,
        max(CASE WHEN rn_desc = 1 THEN timestamp_ms END) AS last_ms,
        min(CASE WHEN rn_asc = 1 THEN energy_in_kwh END) AS first_energy,
        max(CASE WHEN rn_desc = 1 THEN energy_in_kwh END) AS last_energy
    FROM ranked
    GROUP BY d
    HAVING first_ms IS NOT NULL AND last_ms IS NOT NULL AND first_energy IS NOT NULL AND last_energy IS NOT NULL
    ORDER BY d
    """)

    with SessionLocal() as session:
        rows = session.execute(sql, {"start_ms": start_ms, "end_ms": end_ms}).fetchall()

    result = []
    for d_str, first_ms, last_ms, first_energy, last_energy in rows:
        daily_kwh = float(last_energy) - float(first_energy)
        if daily_kwh < 0:
            raise NegativeEnergyError(
                f"Negative daily energy kwh={daily_kwh} for date={d_str}. "
                f"first_energy={first_energy} last_energy={last_energy}. "
                "Cumulative meter may have reset or data is out of order."
            )

        hours_covered = (last_ms - first_ms) / MS_PER_HOUR
        is_partial = hours_covered < 23

        local_noon = datetime.strptime(d_str, "%Y-%m-%d").replace(hour=12, tzinfo=tz)
        result.append({"t": _to_ms(local_noon), "kwh": float(daily_kwh), "is_partial": is_partial})

    return result


def get_moving_avg_daily_usage(daily_energy_data: list[dict], window_days: int = 30) -> list[dict]:
    """
    Calculate 30-day moving average of daily energy consumption.
    For each day, returns the average kWh consumption of the preceding window_days
    (or fewer days if less history is available).
    """
    if not daily_energy_data:
        return []

    sorted_data = sorted(daily_energy_data, key=lambda x: x["t"])
    result = []
    for i, day in enumerate(sorted_data):
        window = sorted_data[max(0, i - window_days + 1) : i + 1]
        avg_kwh = sum(d["kwh"] for d in window) / len(window)
        result.append({"t": day["t"], "kwh": float(avg_kwh)})
    return result


def get_stats(start: datetime, end: datetime) -> dict:
    """
    Compute stats between [start, end]:
      - energy_used_kwh: difference in cumulative energy_in_kwh between first>=start and last<=end
      - min_power_watts, max_power_watts, avg_power_watts
      - count
    """
    start_ms = _to_ms(start)
    end_ms = _to_ms(end)
    with metrics.timed("db.get_stats"):
        with SessionLocal() as session:
            first_row = (
                session.query(EnergyReading)
                .filter(EnergyReading.timestamp_ms >= start_ms, EnergyReading.timestamp_ms <= end_ms)
                .order_by(EnergyReading.timestamp_ms.asc())
                .first()
            )
            last_row = (
                session.query(EnergyReading)
                .filter(EnergyReading.timestamp_ms >= start_ms, EnergyReading.timestamp_ms <= end_ms)
                .order_by(EnergyReading.timestamp_ms.desc())
                .first()
            )
            agg = (
                session.query(
                    func.min(EnergyReading.power_watts),
                    func.max(EnergyReading.power_watts),
                    func.avg(EnergyReading.power_watts),
                    func.count(EnergyReading.power_watts),
                )
                .filter(EnergyReading.timestamp_ms >= start_ms, EnergyReading.timestamp_ms <= end_ms)
                .one()
            )

    min_power, max_power, avg_power, count = agg
    logger.debug(f"[get_stats] {min_power=} {max_power=} {avg_power=} {count=}")
    energy_used = None
    if first_row is not None and last_row is not None:
        if first_row.energy_in_kwh is not None and last_row.energy_in_kwh is not None:
            energy_used = float(last_row.energy_in_kwh) - float(first_row.energy_in_kwh)
            if energy_used < 0:
                raise NegativeEnergyError(
                    f"Negative energy_used_kwh={energy_used:.4f} in window start={start!s} end={end!s}. "
                    f"First reading: ts={first_row.timestamp_ms} energy_in_kwh={first_row.energy_in_kwh}. "
                    f"Last reading: ts={last_row.timestamp_ms} energy_in_kwh={last_row.energy_in_kwh}. "
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
