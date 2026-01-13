import tomllib
from pathlib import Path

import typer


_config_file = Path(__file__).parent.parent / "pyproject.toml"
with _config_file.open("rb") as f:
    _config = tomllib.load(f)

_project_config = _config["project"]
_tool_config = _config["tool"]["config"]

SERVER_URL = _tool_config["server_url"]
FLASK_PORT = _tool_config["flask_port"]
MQTT_PORT = _tool_config["mqtt_port"]
TOPIC = _tool_config["mqtt_topic"]
TASMOTA_UI_URL = _tool_config["tasmota_ui_url"]
DATABASE_URL = f"sqlite:///{_tool_config['database_path']}"
TUNNEL_NAME = _tool_config["tunnel_name"]
DOMAIN_SUFFIX = _tool_config["domain_suffix"]


# fmt: off
def config_cli(
    # Show all
    all: bool = typer.Option(False, "--all", help="Show all configuration values"),
    # Project keys
    project_name: bool = typer.Option(False, "--project-name", help=_project_config['name']),
    project_version: bool = typer.Option(False, "--project-version", help=_project_config['version']),
    # Server settings
    server_url: bool = typer.Option(False, "--server-url", help=SERVER_URL),
    flask_port: bool = typer.Option(False, "--flask-port", help=str(FLASK_PORT)),
    mqtt_port: bool = typer.Option(False, "--mqtt-port", help=str(MQTT_PORT)),
    # MQTT settings
    mqtt_topic: bool = typer.Option(False, "--mqtt-topic", help=TOPIC),
    tasmota_ui_url: bool = typer.Option(False, "--tasmota-ui-url", help=TASMOTA_UI_URL),
    # Database settings
    database_path: bool = typer.Option(False, "--database-path", help=_tool_config['database_path']),
    database_url: bool = typer.Option(False, "--database-url", help=DATABASE_URL),
    # Cloudflare settings
    tunnel_name: bool = typer.Option(False, "--tunnel-name", help=TUNNEL_NAME),
    domain_suffix: bool = typer.Option(False, "--domain-suffix", help=DOMAIN_SUFFIX),
) -> None:
# fmt: on
    """Get configuration values from pyproject.toml."""
    # Show all configuration
    if all:
        typer.echo(f"project_name={_project_config['name']}")
        typer.echo(f"project_version={_project_config['version']}")
        typer.echo(f"server_url={SERVER_URL}")
        typer.echo(f"flask_port={FLASK_PORT}")
        typer.echo(f"mqtt_port={MQTT_PORT}")
        typer.echo(f"mqtt_topic={TOPIC}")
        typer.echo(f"tasmota_ui_url={TASMOTA_UI_URL}")
        typer.echo(f"database_path={_tool_config['database_path']}")
        typer.echo(f"database_url={DATABASE_URL}")
        typer.echo(f"tunnel_name={TUNNEL_NAME}")
        typer.echo(f"domain_suffix={DOMAIN_SUFFIX}")
        return

    # Map parameters to their actual values
    param_map = {
        project_name: _project_config["name"],
        project_version: _project_config["version"],
        server_url: SERVER_URL,
        flask_port: FLASK_PORT,
        mqtt_port: MQTT_PORT,
        mqtt_topic: TOPIC,
        tasmota_ui_url: TASMOTA_UI_URL,
        database_path: _tool_config["database_path"],
        database_url: DATABASE_URL,
        tunnel_name: TUNNEL_NAME,
        domain_suffix: DOMAIN_SUFFIX,
    }

    for is_set, value in param_map.items():
        if is_set:
            typer.echo(value)
            return

    typer.secho("Error: No config key specified. Use --help to see available options.", fg=typer.colors.RED, err=True)
    raise typer.Exit(1)


def main():
    typer.run(config_cli)

if __name__ == "__main__":
    main()
