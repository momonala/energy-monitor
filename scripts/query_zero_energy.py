#!/usr/bin/env python3
"""
Query the DB for readings where energy_in_kwh is 0.
Prints: total number of points, then for each hour the count of such points.
"""
from sqlalchemy import text

from src.database import engine


def main() -> None:
    with engine.connect() as conn:
        # Count all rows where energy_in_kwh is 0 (or 0.0)
        count_result = conn.execute(text("SELECT COUNT(*) FROM energy_readings WHERE energy_in_kwh = 0"))
        n = count_result.scalar_one()

        # Per-hour: hour (date + hour) and count of points with energy = 0
        hours_result = conn.execute(
            text(
                """
                SELECT strftime('%Y-%m-%d %H:00:00', timestamp) AS hour_utc,
                       COUNT(*) AS n
                FROM energy_readings
                WHERE energy_in_kwh = 0
                GROUP BY hour_utc
                ORDER BY hour_utc
            """
            )
        )
        rows = hours_result.fetchall()

    print(f"Number of points with energy_in_kwh = 0: {n}")
    print(f"Per hour ({len(rows)} hours):")
    for hour_utc, count in rows:
        print(f"  {hour_utc}  {count}")


if __name__ == "__main__":
    main()
