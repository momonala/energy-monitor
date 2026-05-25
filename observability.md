# Observability

Energy Monitor ships logs and metrics to [Spyglass](https://github.com/momonala/spyglass) via `src/observability.py`. Configuration lives in `pyproject.toml` under `[tool.config]` (`spyglass_host`, default `localhost:5013`) and can be overridden with `SPYGLASS_HOST`.

**Project name:** `energy-monitor` (from `[project].name` in `pyproject.toml`).

## How stat names are built

Spyglass uses **default prefixing** (`prefix=True`). Every emit becomes:

```text
{project}.{caller_function}.{stat}
```

| Piece | Value in this repo |
|-------|-------------------|
| `project` | `energy-monitor` |
| `caller_function` | Python function that called `metrics.*` (first stack frame outside the `spyglass` package) |
| `stat` | String passed to `increment`, `gauge`, `timing`, or `timed` |

**Example:** `metrics.increment("connect.success")` inside `on_connect` in `src/mqtt.py` is stored as:

```text
energy-monitor.on_connect.connect.success
```

**Querying:** Use a name prefix in Spyglass GET `/metrics`, e.g. `?project=energy-monitor&name=energy-monitor.on_connect`.

```bash
curl "http://localhost:5013/metrics?project=energy-monitor&limit=50"
curl "http://localhost:5013/logs?project=energy-monitor&level=INFO"

curl "http://spyglass.mnalavadi.org/metrics?project=energy-monitor&limit=50"
curl "http://spyglass.mnalavadi.org/logs?project=energy-monitor&level=INFO"
```

## Logging

All application modules use `get_logger(__name__)` after Spyglass initializes in `src/observability.py`. Records go to **stdout** and the Spyglass server (`logs.db` per project). No separate metrics table below—see Spyglass docs for log query parameters.

**Services that configure logging on import:** Flask app (`src/app.py`), MQTT client (`src/mqtt.py`), scheduler (`src/scheduler.py`), database layer, git backup, helpers, Telegram alerts.

---

## Metrics reference

### MQTT (`src/mqtt.py`)

Standalone service: `uv run python -m src.mqtt`. Receives Tasmota telemetry on `tele/tasmota/#`, enqueues MT681 payloads, and persists them on a background worker thread.

| Emitted name | Type | Stat | Where | When | Why / what it tells you |
|--------------|------|------|-------|------|-------------------------|
| `energy-monitor.on_connect.mqtt.connect.success` | counter | `mqtt.connect.success` | `on_connect` | Broker accepts the connection (`reason_code` is not a failure) | MQTT path is up; subscription to `TOPIC` should follow. Use for uptime and reconnect success after outages. |
| `energy-monitor.on_connect.mqtt.connect.failures` | counter | `mqtt.connect.failures` | `on_connect` | Broker rejects or fails the connection | Connection/auth/network problem before any messages flow. Pair with success/disconnect to debug broker or Pi connectivity. |
| `energy-monitor.on_disconnect.mqtt.disconnect` | counter | `mqtt.disconnect` | `on_disconnect` | Client disconnects (clean or broker-side) | Session ended; spikes may correlate with broker restarts, network blips, or service restarts. |
| `energy-monitor.on_message.mqtt.messages.status` | counter | `mqtt.messages.status` | `on_message` | Payload is plain `Online` or `Offline` (not JSON meter data) | Tasmota presence/status traffic, not meter readings. Separates noise from real `MT681` payloads. |
| `energy-monitor.on_message.mqtt.messages.decode_errors` | counter | `mqtt.messages.decode_errors` | `on_message` | Payload is not valid JSON | Malformed or unexpected payloads on the topic. Investigate firmware/config or non-meter publishers on the same topic tree. |
| `energy-monitor.on_message.mqtt.messages.readings` | counter | `mqtt.messages.readings` | `on_message` | Parsed JSON contains `MT681` | Meter readings accepted for the DB queue. Primary **ingress rate** for energy data (expect ~1/min per meter if healthy). |
| `energy-monitor.on_message.mqtt.db_queue.depth` | gauge | `mqtt.db_queue.depth` | `on_message` | Each `MT681` message, value = `db_queue.qsize()` | Backpressure on the single DB worker. Sustained growth means writes are slower than ingest (SQLite lock, disk, or worker errors). |
| `energy-monitor.db_worker.mqtt.db_save.errors` | counter | `mqtt.db_save.errors` | `db_worker` | `save_energy_reading` raises (any exception) | Persist path failed after dequeue. Data may be **lost** for that message unless retried elsewhere. Alert on non-zero rate. |

---

### Database (`src/database.py`)

Used by MQTT worker (writes), Flask API (reads/aggregations), and scheduler (health gauges).

| Emitted name | Type | Stat | Where | When | Why / what it tells you |
|--------------|------|------|-------|------|-------------------------|
| `energy-monitor.save_energy_reading.db.save_reading` | timing | `db.save_reading` | `save_energy_reading` | Around `session.add` / `commit` / `refresh` | Latency of persisting one MT681 row. Watch p95/p99 for SQLite lock contention or slow disk on the Pi. |
| `energy-monitor.save_energy_reading.db.readings.saved` | counter | `db.readings.saved` | `save_energy_reading` | Insert commits successfully | Confirmed new rows in `energy_readings`. Should track closely with `mqtt.messages.readings` minus duplicates. |
| `energy-monitor.save_energy_reading.db.readings.duplicate` | counter | `db.readings.duplicate` | `save_energy_reading` | `IntegrityError` on `timestamp` PK | Same-second duplicate ingest (clock granularity or replay). Harmless but explains gaps between MQTT ingress and row count. |
| `energy-monitor.log_db_health_check.db.readings.last_hour` | gauge | `db.readings.last_hour` | `log_db_health_check` | Hourly scheduler job (and whenever called) | Count of rows in the last hour. **Primary data-freshness signal**; expect hundreds/hour for active metering (~300+ used as healthy threshold). |
| `energy-monitor.log_db_health_check.db.readings.total` | gauge | `db.readings.total` | `log_db_health_check` | Same | Total table size. Slow monotonic growth; useful for capacity and backup size planning. |
| `energy-monitor.log_db_health_check.db.health.low_readings` | counter | `db.health.low_readings` | `log_db_health_check` | `num_readings_last_hour < 300` | Triggers Telegram alert path (non-macOS). Fires when ingest or MQTT path is degraded; use for paging-style monitoring. |
| `energy-monitor.get_readings.db.get_readings` | timing | `db.get_readings` | `get_readings` | SQL aggregation for chart API (`/api/readings`) | Cost of 2-minute bucket query over large ranges. Rises with date span and cache misses. |
| `energy-monitor.get_readings.db.queries.get_readings` | counter | `db.queries.get_readings` | `get_readings` | Each call completes | Dashboard/API read volume for the main time-series endpoint. |
| `energy-monitor.get_stats.db.get_stats` | timing | `db.get_stats` | `get_stats` | Windowed min/max/avg/count query (`/api/stats`) | Latency for selection stats in the UI. |
| `energy-monitor.get_stats.db.queries.get_stats` | counter | `db.queries.get_stats` | `get_stats` | Each call completes | How often users or clients request period statistics. |

---

### HTTP API (`src/app.py`)

Flask dashboard and JSON API. Metrics run in `@app.after_request` (`_spyglass_request_end`) for every routed request.

| Emitted name | Type | Stat | Where | When | Why / what it tells you |
|--------------|------|------|-------|------|-------------------------|
| `energy-monitor._spyglass_request_end.api.{endpoint}.requests` | counter | `api.{endpoint}.requests` | `_spyglass_request_end` | Every HTTP response | Per-route traffic. `{endpoint}` is Flask’s view name (e.g. `api_readings`, `index`, `status`, `energy_summary`). `unknown` if no route matched. |
| `energy-monitor._spyglass_request_end.api.{endpoint}.errors` | counter | `api.{endpoint}.errors` | `_spyglass_request_end` | Response status ≥ 400 | Client or server errors per route (validation 400s, missing params, etc.). |
| `energy-monitor._spyglass_request_end.api.errors` | counter | `api.errors` | `_spyglass_request_end` | Any response status ≥ 400 | Aggregate error rate across all endpoints for simple alerting. |
| `energy-monitor._spyglass_request_end.api.{endpoint}.latency_ms` | timing | `api.{endpoint}.latency_ms` | `_spyglass_request_end` | Every HTTP response | End-to-end request time in ms (includes DB work inside the view). Use to spot slow charts or heavy date ranges. |

**Common `{endpoint}` values:**

| Endpoint name | Route(s) | Role |
|---------------|----------|------|
| `index` | `GET /` | Desktop dashboard HTML |
| `mobile` | `GET /mobile` | Mobile dashboard HTML |
| `compare` | `GET /compare` | Comparison page HTML |
| `api_readings` | `GET /api/readings` | Time-series JSON (hits `get_readings`) |
| `energy_summary` | `GET /api/energy_summary` | Daily usage + moving average |
| `api_latest_reading` | `GET /api/latest_reading` | Last row snapshot |
| `api_stats` | `GET /api/stats` | Windowed stats (hits `get_stats`) |
| `clear_cache` | `GET /api/clear_cache` | Clears `get_readings` LRU cache |
| `status` | `GET /status` | Service health JSON (MQTT flag, counts) |

Static assets may hit Flask without a named endpoint depending on configuration; those appear as `unknown` if applicable.

---

### Scheduler (`src/scheduler.py`, `src/git_tool.py`)

Standalone service: `uv run python -m src.scheduler`. Runs hourly jobs at `:00` and polls `schedule` every 30 seconds.

| Emitted name | Type | Stat | Where | When | Why / what it tells you |
|--------------|------|------|-------|------|-------------------------|
| `energy-monitor._run_scheduled_job.scheduler.jobs.db_health_check` | counter | `scheduler.jobs.db_health_check` | `_run_scheduled_job` | Top of hourly health job | Job actually ran (not just scheduled). Confirms scheduler process is alive at the hour boundary. |
| `energy-monitor._run_scheduled_job.scheduler.jobs.db_git_backup` | counter | `scheduler.jobs.db_git_backup` | `_run_scheduled_job` | Top of hourly git backup job | Backup job fired. Pair with commit/skip metrics below. |
| `energy-monitor.<module>.__main__.scheduler.loop_ticks` | counter | `scheduler.loop_ticks` | `scheduler` `__main__` loop | Every 30s sleep iteration | Scheduler process heartbeat (~2 ticks/min). Absence means hung or crashed loop. |
| `energy-monitor.commit_db_if_changed.scheduler.db_backup.skipped` | counter | `scheduler.db_backup.skipped` | `commit_db_if_changed` | `git diff` shows no DB change | No new backup commit needed. Normal steady state. |
| `energy-monitor.commit_db_if_changed.scheduler.db_backup.committed` | counter | `scheduler.db_backup.committed` | `commit_db_if_changed` | Commit created and `git push` succeeded | DB snapshot pushed to remote backup branch. |
| `energy-monitor.commit_db_if_changed.scheduler.db_backup.push_failed` | counter | `scheduler.db_backup.push_failed` | `commit_db_if_changed` | Push raises `CalledProcessError` | Backup commit may exist locally but not on remote—check auth/network on the Pi. |

Note: DB health gauges and `db.health.low_readings` are emitted from `log_db_health_check` when the scheduler invokes that function (see Database section).

---

## Suggested monitoring views

| Question | Metrics to watch |
|----------|------------------|
| Is MQTT ingesting? | `on_message.mqtt.messages.readings`, `on_connect.mqtt.connect.success` |
| Is data landing in SQLite? | `save_energy_reading.db.readings.saved`, `db_worker.mqtt.db_save.errors` |
| Is the meter feed healthy? | `log_db_health_check.db.readings.last_hour`, `db.health.low_readings` |
| Is the API overloaded or slow? | `api.*.requests`, `api.*.latency_ms`, `get_readings.db.get_readings` timing |
| Is the scheduler running? | `scheduler.loop_ticks`, `scheduler.jobs.*` hourly counters |
| Are backups working? | `scheduler.db_backup.committed` vs `push_failed` / `skipped` |

## Adding new metrics

1. Import `metrics` from `src.observability` (or rely on a module that already imported `src.observability`).
2. Call `metrics.increment`, `gauge`, `timing`, or `with metrics.timed(...)` **without** `prefix=False`.
3. Use a short, descriptive `stat` suffix; the function name will be added automatically.
4. Document the metric in this file under the right section.
