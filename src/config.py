import tomllib
from pathlib import Path

import typer

_config_file = Path(__file__).parent.parent / "pyproject.toml"
with _config_file.open("rb") as f:
    _config = tomllib.load(f)

_project_config = _config["project"]
_tool_config = _config["tool"]["config"]

SPYGLASS_HOST = _tool_config["spyglass_host"]
SPYGLASS_DASHBOARD_URL = _tool_config["spyglass_dashboard_url"]
SPYGLASS_PROJECT = _project_config["name"]
SERVICE_MONITOR_URL = _tool_config["service_monitor_url"]
SERVER_URL = _tool_config["server_url"]
FLASK_PORT = _tool_config["flask_port"]
MQTT_PORT = _tool_config["mqtt_port"]
TOPIC = _tool_config["mqtt_topic"]
TASMOTA_UI_URL = _tool_config["tasmota_ui_url"]
GATEWAY_IP = _tool_config["gateway_ip"]
ACCESS_POINT_IP = _tool_config["access_point_ip"]
DATABASE_PATH = _tool_config["database_path"]
DATABASE_URL = f"sqlite:///{DATABASE_PATH}"
TUNNEL_NAME = _tool_config["tunnel_name"]
DOMAIN_SUFFIX = _tool_config["domain_suffix"]

_CONFIG_VALUES = {
    "project_name": _project_config["name"],
    "project_version": _project_config["version"],
    **_tool_config,
    "database_url": DATABASE_URL,
}


def config_cli(key: str = typer.Argument(None, help="Config key to print; omit to print all")) -> None:
    """Print configuration values from pyproject.toml as key=value lines, or one bare value."""
    if key is None:
        for name, value in _CONFIG_VALUES.items():
            typer.echo(f"{name}={value}")
        return
    if key not in _CONFIG_VALUES:
        known = ", ".join(_CONFIG_VALUES)
        typer.secho(f"Error: unknown config key '{key}'. Known keys: {known}", fg=typer.colors.RED, err=True)
        raise typer.Exit(1)
    typer.echo(_CONFIG_VALUES[key])


def main():
    typer.run(config_cli)


if __name__ == "__main__":
    main()
