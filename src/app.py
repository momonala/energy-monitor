"""Flask application entry point for the energy monitoring dashboard."""

import json
import logging
from pathlib import Path

from flask import Flask
from flask import jsonify
from flask import redirect
from flask import render_template
from flask import request
from flask_compress import Compress

from src.config import FLASK_PORT
from src.config import MQTT_PORT
from src.config import SERVER_URL
from src.config import TASMOTA_UI_URL
from src.config import TOPIC
from src.database import get_avg_daily_energy_usage
from src.database import get_daily_energy_usage
from src.database import get_moving_avg_daily_usage
from src.database import get_readings
from src.database import get_stats
from src.database import latest_energy_reading
from src.database import num_energy_readings_last_hour
from src.database import num_total_energy_readings
from src.helpers import parse_time_param
from src.mqtt import get_mqtt_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Point to static and templates folders at project root (one level up from src/)
project_root = Path(__file__).parent.parent
app = Flask(
    __name__,
    static_folder=str(project_root / "static"),
    template_folder=str(project_root / "templates"),
)
Compress(app)  # Enable gzip compression for responses > 500 bytes
logging.getLogger("werkzeug").setLevel(logging.WARNING)

# Mobile user-agent patterns (exclude iPad - it should see desktop)
MOBILE_PATTERNS = ["Mobile", "Android", "iPhone", "iPod", "BlackBerry", "Windows Phone"]


def is_mobile_user_agent() -> bool:
    """Check if the request is from a mobile device (excluding iPad)."""
    user_agent = request.headers.get("User-Agent", "")
    # Explicitly exclude iPad
    if "iPad" in user_agent:
        return False
    return any(pattern in user_agent for pattern in MOBILE_PATTERNS)


@app.get("/")
def index():
    """Serve the frontend. Redirect mobile users to /mobile."""
    if is_mobile_user_agent():
        return redirect("/mobile")
    return render_template("index.html")


@app.get("/mobile")
def mobile():
    """Serve the mobile-optimized frontend."""
    return render_template("mobile.html")


@app.get("/api/readings")
def api_readings():
    """Return readings as {t, p, e} for timestamp, power, energy."""
    start = parse_time_param(request.args.get("start"))
    end = parse_time_param(request.args.get("end"))
    data = get_readings(start=start, end=end)
    return jsonify(data)


@app.get("/api/energy_summary")
def energy_summary():
    """Return avg daily, per-day energy usage, and 30-day moving average."""
    data = get_readings(start=None, end=None)
    daily_data = get_daily_energy_usage(data)
    return jsonify(
        {
            "avg_daily": get_avg_daily_energy_usage(data),
            "daily": daily_data,
            "moving_avg_30d": get_moving_avg_daily_usage(daily_data, window_days=30),
        }
    )


@app.get("/api/latest_reading")
def api_latest_reading():
    """Return the last reading."""
    return jsonify(latest_energy_reading())


@app.get("/api/stats")
def api_stats():
    """Compute stats between [start, end]."""
    start = parse_time_param(request.args.get("start"))
    end = parse_time_param(request.args.get("end"))
    if start is None or end is None:
        return jsonify({"error": "start and end are required"}), 400
    if end < start:
        start, end = end, start
    stats = get_stats(start=start, end=end)
    return jsonify(
        {
            "start": int(start.timestamp() * 1000),
            "end": int(end.timestamp() * 1000),
            "stats": stats,
        }
    )


@app.get("/api/clear_cache")
def clear_cache():
    """Clear Python LRU cache for get_readings. Visit in browser or call via curl."""
    cache_info = get_readings.cache_info()
    get_readings.cache_clear()
    logger.info(f"Cleared cache: {cache_info}")
    return jsonify(
        {
            "cleared": True,
            "previous": {"hits": cache_info.hits, "misses": cache_info.misses, "size": cache_info.currsize},
        }
    )


@app.get("/status")
def status():
    """Return service status information."""
    mqtt_client = get_mqtt_client()
    mqtt_connected = mqtt_client.is_connected() if mqtt_client else False
    return {
        "status": "ok",
        "mqtt_connected": mqtt_connected,
        "topic": TOPIC,
        "tasmota_url": TASMOTA_UI_URL,
        "flask_url": f"http://{SERVER_URL}:{FLASK_PORT}",
        "mqtt_server": f"{SERVER_URL}:{MQTT_PORT}",
        "last_reading": latest_energy_reading(),
        "num_readings_last_hour": num_energy_readings_last_hour(),
        "num_total_readings": num_total_energy_readings(),
    }


def main():
    logger.info(f"🚀 Starting Flask server on http://0.0.0.0:{FLASK_PORT}")
    logger.info(f"📊 Status: {json.dumps(status(), indent=2)}")
    app.run(host="0.0.0.0", port=FLASK_PORT, debug=True)


if __name__ == "__main__":
    main()
