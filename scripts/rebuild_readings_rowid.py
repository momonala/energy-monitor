"""One-off migration: rebuild energy_readings with timestamp_ms as INTEGER PRIMARY KEY.

A BIGINT primary key is not a rowid alias in SQLite, so the table carried a second index
on timestamp_ms that every insert also had to write. Rebuilding drops that index.

Run from the project root with both services stopped, after backing up data/energy.db:
    uv run python scripts/rebuild_readings_rowid.py
"""

import sqlite3

from src.config import DATABASE_PATH

conn = sqlite3.connect(DATABASE_PATH)
(before,) = conn.execute("SELECT COUNT(*) FROM energy_readings").fetchone()
conn.executescript("""
BEGIN;
CREATE TABLE energy_readings_new (
    timestamp_ms INTEGER NOT NULL PRIMARY KEY,
    meter_id VARCHAR(255),
    power_watts FLOAT,
    energy_in_kwh FLOAT,
    energy_out_kwh FLOAT,
    power_phase_1_watts FLOAT,
    power_phase_2_watts FLOAT,
    power_phase_3_watts FLOAT
);
INSERT INTO energy_readings_new
SELECT timestamp_ms, meter_id, power_watts, energy_in_kwh, energy_out_kwh,
       power_phase_1_watts, power_phase_2_watts, power_phase_3_watts
FROM energy_readings ORDER BY timestamp_ms;
DROP TABLE energy_readings;
ALTER TABLE energy_readings_new RENAME TO energy_readings;
COMMIT;
VACUUM;
""")
(after,) = conn.execute("SELECT COUNT(*) FROM energy_readings").fetchone()
(index_count,) = conn.execute(
    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = 'energy_readings'"
).fetchone()
conn.close()
assert before == after, f"row count changed: {before} -> {after}"
print(f"Rebuilt {after} rows; indexes on energy_readings: {index_count}")
