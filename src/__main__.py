"""Entry point for running the energy monitor application."""

import json

from src.app import FLASK_PORT
from src.app import app
from src.app import logger
from src.app import start_threads
from src.app import status

if __name__ == "__main__":
    start_threads()
    logger.info(f"Running on http://0.0.0.0:{FLASK_PORT}")
    logger.info(f"Status: {json.dumps(status(), indent=2)}")
    app.run(host="0.0.0.0", port=FLASK_PORT, debug=False)
