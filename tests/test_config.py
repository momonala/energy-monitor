import pytest
import typer
from typer.testing import CliRunner

from src.config import config_cli

app = typer.Typer()
app.command()(config_cli)

runner = CliRunner()


@pytest.mark.parametrize(
    "flag,expected_output",
    [
        ("--project-name", "energy-monitor"),
        ("--project-version", "0.1.0"),
        ("--flask-port", "5008"),
        ("--mqtt-port", "1883"),
        ("--server-url", "192.168.2.107"),
        ("--mqtt-topic", "tele/tasmota/#"),
        ("--tasmota-ui-url", "http://192.168.2.110/"),
        ("--database-path", "data/energy.db"),
        ("--database-url", "sqlite:///data/energy.db"),
        ("--tunnel-name", "raspberrypi-tunnel"),
        ("--domain-suffix", "mnalavadi.org"),
    ],
)
def test_config_returns_single_value(flag: str, expected_output: str):
    result = runner.invoke(app, [flag])

    assert result.exit_code == 0
    assert result.stdout.strip() == expected_output


def test_config_all_returns_all_values():
    result = runner.invoke(app, ["--all"])

    assert result.exit_code == 0
    assert "project_name=energy-monitor" in result.stdout
    assert "project_version=0.1.0" in result.stdout
    assert "flask_port=5008" in result.stdout
    assert "mqtt_port=1883" in result.stdout
    assert "server_url=192.168.2.107" in result.stdout
    assert "mqtt_topic=tele/tasmota/#" in result.stdout
    assert "database_url=sqlite:///data/energy.db" in result.stdout
    assert "tunnel_name=raspberrypi-tunnel" in result.stdout
    assert "domain_suffix=mnalavadi.org" in result.stdout


def test_config_without_flag_fails():
    result = runner.invoke(app, [])

    assert result.exit_code == 1
    assert "Error: No config key specified" in result.output
