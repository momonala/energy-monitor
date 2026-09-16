"""One-off migration: naive local-time DateTime PK -> UTC epoch-ms INTEGER PK.

The 'utc' strftime modifier interprets the stored naive string as OS-local time, so each
row converts with the DST offset that was in effect when it was written. INSERT OR IGNORE
dedupes rows that differ only at microsecond precision (double-ingestion bursts).

Run from the project root with both services stopped:
    uv run python scripts/migrate_timestamp_ms.py
"""

import sqlite3

from src.config import DATABASE_PATH

conn = sqlite3.connect(DATABASE_PATH)
(before,) = conn.execute("SELECT COUNT(*) FROM energy_readings").fetchone()
conn.executescript("""
BEGIN;
CREATE TABLE energy_readings_new (
    timestamp_ms BIGINT NOT NULL PRIMARY KEY,
    meter_id VARCHAR(255),
    power_watts FLOAT,
    energy_in_kwh FLOAT,
    energy_out_kwh FLOAT,
    power_phase_1_watts FLOAT,
    power_phase_2_watts FLOAT,
    power_phase_3_watts FLOAT
);
INSERT OR IGNORE INTO energy_readings_new
SELECT CAST(strftime('%s', timestamp, 'utc') AS INTEGER) * 1000
       + CAST(substr(timestamp, 21, 3) AS INTEGER),
       meter_id, power_watts, energy_in_kwh, energy_out_kwh,
       power_phase_1_watts, power_phase_2_watts, power_phase_3_watts
FROM energy_readings;
DROP TABLE energy_readings;
ALTER TABLE energy_readings_new RENAME TO energy_readings;
COMMIT;
VACUUM;
""")
(after,) = conn.execute("SELECT COUNT(*) FROM energy_readings").fetchone()
conn.close()
print(f"Migrated {before} rows -> {after} ({before - after} microsecond-duplicates dropped)")
