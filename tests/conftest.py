"""Shared fixtures for tests."""

import tempfile
from datetime import datetime
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src.app import app as flask_app
from src.database import Base
from src.database import EnergyReading
from src.helpers import local_timezone


@pytest.fixture
def app():
    """Flask app with test config."""
    flask_app.config["TESTING"] = True
    return flask_app


@pytest.fixture
def client(app):
    """Flask test client."""
    return app.test_client()


@pytest.fixture
def test_db():
    """In-memory test database."""
    db_fd, db_path = tempfile.mkstemp()
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, future=True)

    yield Session

    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def sample_readings(test_db):
    """Create sample energy readings spanning 3 days."""
    session = test_db()
    now = datetime.now(local_timezone())
    base_time = now - timedelta(days=2)

    readings_data = []
    for i in range(72):  # 3 days, hourly
        timestamp = base_time + timedelta(hours=i)
        reading = EnergyReading(
            timestamp=timestamp,
            meter_id="test_meter",
            power_watts=500.0 + (i * 10),
            energy_in_kwh=1000.0 + (i * 0.5),
            energy_out_kwh=0.0,
            power_phase_1_watts=200.0,
            power_phase_2_watts=150.0,
            power_phase_3_watts=150.0,
            raw_payload='{"test": true}',
        )
        session.add(reading)
        # Store data we'll need after session closes
        readings_data.append(
            {
                "timestamp": timestamp,
                "power_watts": reading.power_watts,
                "energy_in_kwh": reading.energy_in_kwh,
            }
        )

    session.commit()
    session.close()
    return readings_data
