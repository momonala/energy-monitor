import json
import logging
from datetime import datetime
from datetime import timedelta
from functools import lru_cache

import pandas as pd
import sqlalchemy
from sqlalchemy import Column
from sqlalchemy import DateTime
from sqlalchemy import Float
from sqlalchemy import String
from sqlalchemy import Text
from sqlalchemy import create_engine
from sqlalchemy import func
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker

from src.config import DATABASE_URL
from src.helpers import local_timezone
from src.helpers import timed
from src.telegram import report_missing_data_to_telegram

logger = logging.getLogger(__name__)


engine = create_engine(
    DATABASE_URL,
    future=True,
)

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
    """Create all tables if they do not exist."""
    Base.metadata.create_all(bind=engine)
    logger.info("Created all tables")


def save_energy_reading(tasmota_payload: str):
    """Persist a single MT681 energy reading payload."""
    mt_payload = tasmota_payload["MT681"]
    timestamp = datetime.now(local_timezone())
    reading = EnergyReading(
        meter_id=str(mt_payload.get("Meter_id")),
        power_watts=float(mt_payload.get("Power")),
        energy_in_kwh=float(mt_payload.get("E_in")),
        energy_out_kwh=float(mt_payload.get("E_out")),
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
    Fetch readings in ascending order. Optionally filter by time range.
    Returns a list of dicts with timestamp (ms since epoch), power_watts, and energy_in_kwh.
    """
    # Convert to local timezone
    with SessionLocal() as session:
        query = session.query(EnergyReading).order_by(EnergyReading.timestamp.asc())
        if start is not None:
            start = start.astimezone(local_timezone())
            query = query.filter(EnergyReading.timestamp >= start)
        if end is not None:
            end = end.astimezone(local_timezone())
            query = query.filter(EnergyReading.timestamp <= end)
        rows = query.all()

    logger.debug(
        f"""⚠️ [get_readings] Found {len(rows)} readings for {start=} {end=}:
    ⚠️ [get_readings] oldest reading: {rows[0].timestamp.isoformat()}
    ⚠️ [get_readings] latest reading: {rows[-1].timestamp.isoformat()}"""
    )
    result: list[dict] = []
    for r in rows:
        # Convert to ms since epoch for charting
        ts = int(r.timestamp.timestamp() * 1000)
        result.append(
            {
                "t": ts,
                "p": r.power_watts,
                "e": r.energy_in_kwh,
            }
        )
    return result


def get_avg_daily_energy_usage(readings_data: list[dict]) -> float:
    """Return the average daily energy usage over the last year from cumulative readings."""
    df = pd.DataFrame(readings_data)
    df["t"] = pd.to_datetime(df["t"], unit="ms")
    df.columns = ["time", "power", "energy"]
    df = df.sort_values("time")

    last_timestamp = df["time"].max()
    one_year_ago = last_timestamp - pd.Timedelta(days=365)

    last_year_data = df[df["time"] >= one_year_ago]

    if len(last_year_data) < 2:
        raise ValueError("Not enough data in the last year")

    energy_start = last_year_data["energy"].iloc[0]
    energy_end = last_year_data["energy"].iloc[-1]

    days_span = (last_year_data["time"].iloc[-1] - last_year_data["time"].iloc[0]).total_seconds() / 86400
    if days_span <= 0:
        raise ValueError("Invalid time span")

    return (energy_end - energy_start) / days_span


def get_daily_energy_usage(readings_data: list[dict]) -> list[dict]:
    """Calculate daily energy consumption from cumulative readings, handling partial days."""
    if not readings_data:
        return []

    df = pd.DataFrame(readings_data)
    df["time"] = pd.to_datetime(df["t"], unit="ms")
    df["energy"] = df["e"]
    df = df.sort_values("time")
    df = df[df["energy"].notna() & (df["energy"] > 0)]

    if len(df) < 2:
        return []

    df["date"] = df["time"].dt.date

    # Group by date and get first/last energy reading per day
    daily = df.groupby("date").agg(
        energy_start=("energy", "first"),
        energy_end=("energy", "last"),
        first_time=("time", "first"),
        last_time=("time", "last"),
    )

    # Calculate daily consumption as difference between end and start of each day
    daily["daily_kwh"] = daily["energy_end"] - daily["energy_start"]

    # Mark partial days (less than 23 hours of coverage)
    daily["hours_covered"] = (daily["last_time"] - daily["first_time"]).dt.total_seconds() / 3600
    daily["is_partial"] = daily["hours_covered"] < 23

    # Build result: use midpoint of each day as timestamp
    result = []
    for date, row in daily.iterrows():
        midpoint = datetime.combine(date, datetime.min.time().replace(hour=12))
        midpoint = midpoint.replace(tzinfo=local_timezone())
        result.append(
            {
                "t": int(midpoint.timestamp() * 1000),
                "kwh": float(row["daily_kwh"]),
                "is_partial": bool(row["is_partial"]),
            }
        )

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
        
        result.append({
            "t": day["t"],
            "kwh": float(avg_kwh),
        })
    
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

    return {
        "energy_used_kwh": energy_used,
        "min_power_watts": float(min_power) if min_power is not None else None,
        "max_power_watts": float(max_power) if max_power is not None else None,
        "avg_power_watts": float(avg_power) if avg_power is not None else None,
        "count": int(count) if count is not None else 0,
    }


if __name__ == "__main__":
    init_db()
