"""Entry point for running the energy monitor application."""

from src.app import app, logger, start_threads, status, FLASK_PORT
import json

if __name__ == "__main__":
    start_threads()
    logger.info(f"Running on http://0.0.0.0:{FLASK_PORT}")
    logger.info(f"Status: {json.dumps(status(), indent=2)}")
    app.run(host="0.0.0.0", port=FLASK_PORT, debug=False)
