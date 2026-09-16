#!/bin/bash
# WAL-safe SQLite backup with rotation. Run from the project root (systemd timer does).
set -euo pipefail

db="data/energy.db"
backup_dir="data/backups"
keep=7

mkdir -p "$backup_dir"
backup_file="$backup_dir/energy-$(date +%Y%m%d).db"
sqlite3 "$db" ".backup '$backup_file'"
ls -1t "$backup_dir"/energy-*.db | tail -n +$((keep + 1)) | xargs -r rm
echo "Backed up $db to $backup_file ($(du -h "$backup_file" | cut -f1))"
