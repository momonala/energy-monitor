# Energy Monitor

[CI](https://github.com/momonala/energy-monitor/actions/workflows/ci.yml)
[codecov](https://codecov.io/gh/momonala/energy-monitor)

Real-time energy monitoring dashboard for MT681 smart meters via Tasmota MQTT.

## Architecture

```mermaid
flowchart LR
    subgraph Hardware
        Meter[MT681 Meter] -->|IR| Tasmota[Tasmota IR Reader]
    end
    subgraph Infrastructure
        Tasmota -->|MQTT :1883| Broker[MQTT Broker]
    end
    subgraph Services
        Broker --> MQTT[MQTT Service]
        MQTT --> DB[(SQLite)]
        Flask[Flask :5008] --> DB
        Flask --> UI[Web Dashboard]
        Scheduler[Scheduler] --> DB
        Scheduler --> Git[Git Auto-commit]
    end
```

**Data flow:** Meter → IR → Tasmota → MQTT Broker → MQTT Service → SQLite → Flask REST API → Browser

## Hardware

- MT681 smart meter (or compatible SML meter)
- [Stromleser WiFi Smart Meter IR Reading Head](https://www.amazon.de/-/en/dp/B0DJP2MDLK) (Tasmota-flashed)

## Prerequisites

- Python 3.12+
- uv (Python package manager)
- MQTT broker (e.g., Mosquitto) running on the network
- Tasmota device configured to publish to `tele/tasmota/#`
- [Service Monitor](https://github.com/momonala/service-monitor) on `:5001` for Telegram alerts (optional; alert failures are logged and ignored)

## Installation

1. Clone and install dependencies:
  ```bash
   git clone https://github.com/momonala/energyMeter.git
   cd energyMeter
   curl -LsSf https://astral.sh/uv/install.sh | sh
   uv sync
  ```
2. Initialize the database:
  ```bash
   uv run python -m src.database
  ```
3. Configure `pyproject.toml`:
  Edit the `[tool.config]` section with your settings (MQTT, ports, `service_monitor_url`, etc.).

## Running

```bash
uv run app
```

Open `http://localhost:5008`

## Observability (Spyglass)

Logs and metrics ship to a local [Spyglass](https://github.com/momonala/spyglass) server (`spyglass_host` in `[tool.config]`, default `localhost:5013`).

```bash
# Terminal 1 — one Spyglass server for all projects on this machine
cd ~/code/spyglass && uv tool install --editable . && spyglass serve

# Terminal 2 — energy-monitor (project name: energy-monitor)
uv run app
uv run python -m src.mqtt
uv run python -m src.scheduler
```

Query data:

```bash
curl "http://localhost:5013/metrics?project=energy-monitor&limit=20"
curl "http://localhost:5013/logs?project=energy-monitor&level=INFO"
```

## Dashboard Features

### Layout

- **Chart**: Power (W), cumulative energy (kWh), and daily usage trend (30-day moving average or total average)
- **Selection Stats**: Statistics for the selected time range
- **Period Summary**: Today, this week, this month, and total consumption

### Live Updates

- Data refreshes every 10 seconds via incremental polling
- Only new data points are fetched and appended to the chart
- Connection status and last-updated timestamp in the header; data point count in the stats panel
- Auto-expands view if watching near real-time (within 2 minutes of latest data)


## Mobile Dashboard

A simplified, mobile-optimized interface is available at `/mobile`. Mobile users (iPhone, Android) are automatically redirected; iPad users see the full desktop dashboard.

## Project Structure

```
energy-monitor/
├── src/
│   ├── app.py          # Flask entry point, API routes, mobile detection
│   ├── database.py     # SQLAlchemy models, queries, stats
│   ├── mqtt.py         # Standalone MQTT client service entry point
│   ├── scheduler.py    # Standalone scheduler entry point (health check, git commit)
│   ├── git_tool.py     # Auto-commit DB changes to git
│   ├── helpers.py      # Time parsing utilities
│   ├── config.py       # Configuration constants
│   └── alerts.py       # Telegram alerts via Service Monitor API
├── templates/
│   ├── _base.html      # Shared shell (sidebar, header, Spyglass layout)
│   ├── index.html      # Desktop dashboard
│   ├── compare.html    # Period comparison page
│   └── mobile.html     # Mobile dashboard
├── static/
│   ├── css/
│   │   ├── tokens.css      # Design tokens (Spyglass-aligned)
│   │   ├── base.css        # Reset, typography, shell
│   │   ├── components.css  # Buttons, cards, stats, tables
│   │   └── dashboard.css   # Page-specific layouts
│   ├── app.js          # Desktop frontend: charting, interactions, live updates
│   ├── compare.js      # Compare page frontend
│   ├── mobile.js       # Mobile frontend: simplified chart, stats, daily table
│   ├── shared.js       # Shared utilities and CSS→JS theme bridge
│   └── styles.css      # Stylesheet entry point (@imports layered CSS)
├── data/
│   └── energy.db       # SQLite database
├── tests/
│   └── test_*.py       # Test files
└── install/
    ├── install.sh                              # Raspberry Pi setup script
    ├── projects_energy-monitor.service         # systemd service for web app
    ├── projects_energy-monitor_mqtt.service    # systemd service for MQTT client
    └── projects_energy-monitor_data-backup-scheduler.service # systemd service for scheduler
```

## API Endpoints


| Endpoint              | Method | Description                                              |
| --------------------- | ------ | -------------------------------------------------------- |
| `/`                   | GET    | Serve desktop dashboard (redirects mobile to `/mobile`)  |
| `/mobile`             | GET    | Serve mobile-optimized dashboard                         |
| `/api/readings`       | GET    | Fetch readings with optional time range                  |
| `/api/latest_reading` | GET    | Get most recent reading                                  |
| `/api/energy_summary` | GET    | Get avg daily usage, daily usage, and 30d moving average |
| `/api/stats`          | GET    | Compute statistics for a time range                      |
| `/status`             | GET    | Service health, connection status, job info              |


### `/api/readings`

Query params:

- `start` - ISO-8601 string or ms since epoch (optional)
- `end` - ISO-8601 string or ms since epoch (optional)
- `after` - Unix timestamp; returns only records after this time (for incremental updates)

Response:

```json
[
  {"t": 1701432000000, "p": 450.5, "e": 12345.67}
]
```

- `t`: timestamp (ms since epoch)
- `p`: power (watts)
- `e`: cumulative energy (kWh)

### `/api/energy_summary`

Query params:

- `start` - ISO-8601 string or ms since epoch (optional; limits returned `daily` and `moving_avg_30d`)
- `end` - ISO-8601 string or ms since epoch (optional; defaults to now)

When `start`/`end` are omitted, returns full default history (~52 weeks). When scoped, the server still loads up to 30 days of history internally so the moving average is accurate.

Response:

```json
{
  "avg_daily": 15.2,
  "daily": [
    {"t": 1701432000000, "kwh": 14.5, "is_partial": false},
    {"t": 1701518400000, "kwh": 15.8, "is_partial": false}
  ],
  "moving_avg_30d": [
    {"t": 1701432000000, "kwh": 14.2},
    {"t": 1701518400000, "kwh": 14.8}
  ]
}
```

- `avg_daily`: Average daily kWh over the last year
- `daily`: Daily kWh consumption for each day
- `moving_avg_30d`: 30-day moving average of daily consumption (or fewer days for dates with less history)

### `/api/stats`

Query params (required):

- `start` - ISO-8601 string or ms since epoch
- `end` - ISO-8601 string or ms since epoch

Response:

```json
{
  "start": 1701432000000,
  "end": 1701518400000,
  "stats": {
    "energy_used_kwh": 12.5,
    "min_power_watts": 120.0,
    "max_power_watts": 3500.0,
    "avg_power_watts": 450.2,
    "count": 8640
  }
}
```

## Data Model

```
EnergyReading
├── timestamp: DateTime (PK, indexed)
├── meter_id: String
├── power_watts: Float
├── energy_in_kwh: Float
├── energy_out_kwh: Float
├── power_phase_1_watts: Float
├── power_phase_2_watts: Float
├── power_phase_3_watts: Float
└── raw_payload: Text (JSON)
```

## Key Concepts


| Concept          | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `energy_in_kwh`  | Cumulative energy consumed from grid (meter reading)    |
| `energy_out_kwh` | Cumulative energy exported to grid (for solar)          |
| `power_watts`    | Instantaneous power draw                                |
| `MT681`          | Smart meter model; payload key in Tasmota MQTT messages |
| `E_in` / `E_out` | Tasmota payload fields for energy in/out                |


## Storage


| Path                | Purpose                           |
| ------------------- | --------------------------------- |
| `data/energy.db`    | SQLite database with all readings |
| `data/energy.db.bk` | Backup copy (created hourly)      |


## Background Jobs

The scheduler service runs periodic tasks via the `schedule` library:


| Schedule     | Task                                                              |
| ------------ | ----------------------------------------------------------------- |
| Hourly `:00` | Log DB health check (reading counts); alert if &lt; 300/hour     |
| Hourly `:00` | Commit DB to git if changed (amend + force push)                  |


### Alerts

Sent as Markdown via Service Monitor `POST /api/alert` (`service_monitor_url` in `[tool.config]`, default `http://localhost:5001`). Failures are logged and never crash the app.


| Trigger | Message |
| ------- | ------- |
| Tasmota LWT `Offline` / `Online` | Hardware device went offline / came online |
| Hourly health check | Fewer than 300 readings in the last hour |


Run services separately:

```bash
# Run MQTT client
uv run python -m src.mqtt

# Run scheduler
uv run python -m src.scheduler
```

## Deployment (Raspberry Pi)

1. Run the install script:
  ```bash
   cd install
   ./install.sh
  ```
   This will:
  - Install uv (if not already installed)
  - Install dependencies via uv
  - Set up systemd services (web app, MQTT client, and scheduler)
  - Configure Cloudflare tunnel (if applicable)
2. Service management:
  Three services are installed:

  | Service                                                 | Purpose                                       | Port |
  | ------------------------------------------------------- | --------------------------------------------- | ---- |
  | `projects_energy-monitor.service`                       | Flask web application                         | 5008 |
  | `projects_energy-monitor_mqtt.service`                  | MQTT client for receiving meter data          | N/A  |
  | `projects_energy-monitor_data-backup-scheduler.service` | Hourly database health checks and git backups | N/A  |

  ```bash
  # Check status
  sudo systemctl status projects_energy-monitor.service
  sudo systemctl status projects_energy-monitor_mqtt.service
  sudo systemctl status projects_energy-monitor_data-backup-scheduler.service

  # View logs
  sudo journalctl -u projects_energy-monitor.service -f
  sudo journalctl -u projects_energy-monitor_mqtt.service -f
  sudo journalctl -u projects_energy-monitor_data-backup-scheduler.service -f

  # Restart services
  sudo systemctl restart projects_energy-monitor.service
  sudo systemctl restart projects_energy-monitor_mqtt.service
  sudo systemctl restart projects_energy-monitor_data-backup-scheduler.service
  ```
