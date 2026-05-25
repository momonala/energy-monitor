"""Spyglass logging and metrics for energy-monitor."""

import logging
import os

from spyglass import initialize

from src.config import SPYGLASS_HOST
from src.config import SPYGLASS_PROJECT

logger, metrics = initialize(
    host=os.environ.get("SPYGLASS_HOST", SPYGLASS_HOST),
    project=SPYGLASS_PROJECT,
)


def get_logger(name: str) -> logging.Logger:
    """Return a module logger after Spyglass logging is configured."""
    return logging.getLogger(name)
