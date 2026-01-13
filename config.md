# Centralize Configuration in pyproject.toml

## 📋 Overview

This plan creates a unified, maintainable configuration system by:

- Storing all config in `[tool.config]` section of `pyproject.toml`
- Creating a beautiful Typer CLI (`uv run config --help`)
- Eliminating hardcoded values in install scripts
- Adding comprehensive tests

**Result:** Single source of truth, self-documenting, version-controlled.

---

## 🎯 Implementation Steps

### 1. Add `[tool.config]` Section to `pyproject.toml`

**Important:** Place this section **near the top** of `pyproject.toml`, right after the `[project]` section (before `[build-system]` and other `[tool.*]` sections). This makes your configuration easily discoverable.

Add configuration after `[project]` section:

```toml
[project]
name = "your-project-name"
# ... rest of project metadata

[tool.config]
# Server settings
server_url = "192.168.x.x"
flask_port = 5008
mqtt_port = 1883

# Database
database_path = "data/energy.db"

# MQTT settings (if applicable)
mqtt_topic = "tele/tasmota/#"
tasmota_ui_url = "http://192.168.x.x/"

[build-system]
# ... rest of file
```

**Customize:** Add/remove fields based on your project needs.

---

### 2. Create/Rewrite `src/config.py`

Replace old config with this complete implementation:

```python
import tomllib
from pathlib import Path

import typer

# Load pyproject.toml
_config_file = Path(__file__).parent.parent / "pyproject.toml"
with _config_file.open("rb") as f:
    _config = tomllib.load(f)

_project_config = _config["project"]
_tool_config = _config["tool"]["config"]

# Export configuration variables
SERVER_URL = _tool_config["server_url"]
FLASK_PORT = _tool_config["flask_port"]
MQTT_PORT = _tool_config["mqtt_port"]
TOPIC = _tool_config["mqtt_topic"]
TASMOTA_UI_URL = _tool_config["tasmota_ui_url"]
DATABASE_URL = f"sqlite:///{_tool_config['database_path']}"

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
    # Add other config options as needed...
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
        # Add all your config values here
        return

    # Map parameters to their actual values
    param_map = {
        project_name: _project_config["name"],
        project_version: _project_config["version"],
        server_url: SERVER_URL,
        flask_port: FLASK_PORT,
        mqtt_port: MQTT_PORT,
        # Add all your config mappings here
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
```

**Key Features:**

- ✅ Works as library: `from src.config import FLASK_PORT`
- ✅ Works as CLI: `uv run config --flask-port`
- ✅ Help shows current values
- ✅ `--all` flag for viewing everything

---

### 3. Add Config Script to `pyproject.toml`

Add to `[project.scripts]` section:

```toml
[project.scripts]
app = "src.app:main"
config = "src.config:main"  # ← Add this
```

Now you can use: `uv run config --help`

---

### 4. Add `typer` Dependency

In `pyproject.toml` dependencies:

```toml
dependencies = [
    # ... existing deps
    "typer>=0.9.0",
]
```

---

### 5. Update Install Script (`install/install.sh`)

#### a) Install `uv` first, then read config:

```bash
set -e

# Colors
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "✅ Installing uv (Python package manager)"
if ! command -v uv &> /dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
else
    echo "✅ uv is already installed. Updating to latest version."
    uv self update
fi

echo "✅ Installing project dependencies with uv"
uv sync

# Extract configuration from pyproject.toml
service_name=$(uv run config --project-name)
service_port=$(uv run config --flask-port)

# Cloudflare settings (hardcoded or from config)
tunnel_name="your-tunnel-name"
domain_suffix="your-domain.com"
```

#### b) Display config with colors:

```bash
echo "📋 Configuration:"
{
    uv run config --all | while IFS='=' read -r key value; do
        echo  "   ${CYAN}${key}${NC}|${YELLOW}${value}${NC}"
    done
    echo  "   ${CYAN}cloudflare_domain${NC}|${YELLOW}${service_name}.${domain_suffix}${NC}"
    echo  "   ${CYAN}tunnel_name${NC}|${YELLOW}${tunnel_name}${NC}"
} | column -t -s '|'
```

---

### 6. Create Tests (`tests/test_config.py`)

```python
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
        ("--project-name", "your-project-name"),
        ("--flask-port", "5008"),
        # Add all your config flags here
    ],
)
def test_config_returns_single_value(flag: str, expected_output: str):
    result = runner.invoke(app, [flag])
    
    assert result.exit_code == 0
    assert result.stdout.strip() == expected_output


def test_config_all_returns_all_values():
    result = runner.invoke(app, ["--all"])
    
    assert result.exit_code == 0
    assert "project_name=" in result.stdout
    assert "flask_port=" in result.stdout


def test_config_without_flag_fails():
    result = runner.invoke(app, [])
    
    assert result.exit_code == 1
    assert "Error: No config key specified" in result.output


```

Run with: `uv run pytest tests/test_config.py -v`

---

### 7. Update README.md

Add configuration section:

````markdown
## Configuration

All configuration is in `pyproject.toml` under `[tool.config]`:

```toml
[tool.config]
server_url = "192.168.x.x"
flask_port = 5008
# ... other settings
````

### View Configuration

```bash
# View all config
uv run config --help

# Get specific values
uv run config --flask-port
uv run config --server-url

# Show everything
uv run config --all
```

---

## 📦 Complete File Checklist

- [ ] `pyproject.toml` - Added `[tool.config]` section
- [ ] `pyproject.toml` - Added `config = "src.config:main"` to `[project.scripts]`
- [ ] `pyproject.toml` - Added `typer>=0.9.0` to dependencies
- [ ] `src/config.py` - Complete rewrite with Typer CLI
- [ ] `install/install.sh` - Updated to use `uv run config`
- [ ] `install/install.sh` - Added colored config display
- [ ] `tests/test_config.py` - Created comprehensive tests
- [ ] `README.md` - Documented new config approach

---

## ✅ Verification Steps

1. **Test library imports:**
   ```bash
   uv run python -c "from src.config import FLASK_PORT; print(FLASK_PORT)"
   ```

2. **Test CLI:**
   ```bash
   uv run config --help
   uv run config --project-name
   uv run config --all
   ```

3. **Run tests:**
   ```bash
   uv run pytest tests/test_config.py -v
   ```

4. **Test install script:**
   ```bash
   ./install/install.sh
   ```


---

## 🎨 Benefits

✅ **Single source of truth** - All config in `pyproject.toml`

✅ **Self-documenting** - `--help` shows current values

✅ **Type-safe** - Python reads with proper types

✅ **Testable** - Comprehensive test coverage

✅ **Beautiful CLI** - Typer-powered with colors

✅ **No duplication** - Used by both app and install script

✅ **Version controlled** - No separate `.env` files

✅ **Installable** - `uv run config` works anywhere

---

## 🔄 Adapting to Your Project

### For different config keys:

1. Update `[tool.config]` in `pyproject.toml`
2. Add exports in `src/config.py` (e.g., `API_KEY = _tool_config["api_key"]`)
3. Add CLI option in `config_cli()` function
4. Add to `param_map` and `--all` output
5. Add test case in `tests/test_config.py`

### For non-Python projects:

The same pattern works! Just replace `src/config.py` with:

- Node.js: Use a simple script that parses `pyproject.toml` with a TOML library
- Shell: Use `yq` or `dasel` to parse TOML directly
- Any language: Parse TOML and expose via CLI

---

## 📝 Notes

- Requires **Python 3.11+** for `tomllib` (stdlib)
- Requires **`uv`** for script execution
- No environment variables needed (simplified from original plan)
- Cloudflare settings can be in config or hardcoded as needed
- Tests use `pytest.mark.parametrize` for DRY test code

---

**Created:** 2026-01-13

**Last Updated:** 2026-01-13

**Status:** ✅ Complete & Production-Ready

