#!/usr/bin/env python3
"""
Set energy_in_kwh and energy_out_kwh to NULL where they are 0.
Unifies old data with the rule: we do not store 0 for cumulative energy (treat as invalid/reset).
Run from project root: uv run python scripts/nullify_zero_energy.py
"""
from sqlalchemy import text

from src.database import engine


def main() -> None:
    with engine.begin() as conn:
        # Count before
        r = conn.execute(text("SELECT COUNT(*) FROM energy_readings WHERE energy_in_kwh = 0"))
        n_in_before = r.scalar_one()
        r = conn.execute(text("SELECT COUNT(*) FROM energy_readings WHERE energy_out_kwh = 0"))
        n_out_before = r.scalar_one()

        # Update: set 0 → NULL for both columns
        r_in = conn.execute(text("UPDATE energy_readings SET energy_in_kwh = NULL WHERE energy_in_kwh = 0"))
        updated_in = r_in.rowcount
        r_out = conn.execute(
            text("UPDATE energy_readings SET energy_out_kwh = NULL WHERE energy_out_kwh = 0")
        )
        updated_out = r_out.rowcount

    print(f"energy_in_kwh:  {n_in_before} rows were 0 → set to NULL ({updated_in} updated)")
    print(f"energy_out_kwh: {n_out_before} rows were 0 → set to NULL ({updated_out} updated)")
    print("Done.")


if __name__ == "__main__":
    main()
