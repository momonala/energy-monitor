import pytest
import typer
from typer.testing import CliRunner

from src.config import config_cli

app = typer.Typer()
app.command()(config_cli)

runner = CliRunner()


@pytest.mark.parametrize(
    "key,expected_output",
    [
        ("project_name", "energy-monitor"),
        ("project_version", "0.1.0"),
        ("flask_port", "5008"),
        ("mqtt_port", "1883"),
        ("server_url", "localhost"),
        ("mqtt_topic", "tele/tasmota/#"),
        ("tasmota_ui_url", "http://192.168.2.116/"),
        ("database_path", "data/energy.db"),
        ("database_url", "sqlite:///data/energy.db"),
        ("tunnel_name", "raspberrypi-tunnel"),
        ("domain_suffix", "mnalavadi.org"),
        ("service_monitor_url", "http://localhost:5001"),
        ("spyglass_dashboard_url", "https://spyglass.mnalavadi.org/dashboard/energy-monitor"),
    ],
)
def test_config_returns_single_value(key: str, expected_output: str):
    result = runner.invoke(app, [key])

    assert result.exit_code == 0
    assert result.stdout.strip() == expected_output


def test_config_without_key_returns_all_values():
    result = runner.invoke(app, [])

    assert result.exit_code == 0
    assert "project_name=energy-monitor" in result.stdout
    assert "flask_port=5008" in result.stdout
    assert "mqtt_topic=tele/tasmota/#" in result.stdout
    assert "database_url=sqlite:///data/energy.db" in result.stdout
    assert "spyglass_dashboard_url=https://spyglass.mnalavadi.org/dashboard/energy-monitor" in result.stdout


def test_config_with_unknown_key_fails():
    result = runner.invoke(app, ["not_a_key"])

    assert result.exit_code == 1
    assert "unknown config key" in result.output
