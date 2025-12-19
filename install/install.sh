service_name="energy-monitor"
service_name_underscore="energy_monitor"
service_port=5008
python_version="3.12"

set -e  # Exit immediately if a command exits with a non-zero status

# function, returns true if on mac else false
is_mac() {
    [ "$(uname)" == "Darwin" ]
}

echo "✅ Creating conda environment: $service_name_underscore with Python $python_version"
if ! conda env list | grep -q "^$service_name_underscore\s"; then
    conda create -n $service_name_underscore python=$python_version -y
else
    echo "✅ Conda environment '$service_name_underscore' already exists. Skipping creation."
fi

echo "✅ Activating conda environment: $service_name_underscore"
if is_mac; then
    source /Users/mnalavadi/miniconda3/etc/profile.d/conda.sh
else
    source /home/mnalavadi/miniconda3/etc/profile.d/conda.sh
fi
conda activate $service_name_underscore

echo "✅ Installing required Python packages"
pip install -U poetry
poetry install --no-root

# if running on mac, exit now
if is_mac; then
    echo "✅ Running on macOS, skipping systemd service setup"
    exit 0
fi

echo "✅ Copying service file to systemd directory"
sudo cp install/projects_${service_name_underscore}.service /lib/systemd/system/projects_${service_name_underscore}.service

echo "✅ Setting permissions for the service file"
sudo chmod 644 /lib/systemd/system/projects_${service_name_underscore}.service

echo "✅ Reloading systemd daemon"
sudo systemctl daemon-reload
sudo systemctl daemon-reexec

echo "✅ Enabling the service: projects_${service_name_underscore}.service"
sudo systemctl enable projects_${service_name_underscore}.service
sudo systemctl restart projects_${service_name_underscore}.service
sudo systemctl status projects_${service_name_underscore}.service --no-pager

echo "✅ Adding Cloudflared service"
/home/mnalavadi/add_cloudflared_service.sh ${service_name}.mnalavadi.org $service_port
echo "✅ Configuring Cloudflared DNS route"
cloudflared tunnel route dns raspberrypi-tunnel ${service_name}.mnalavadi.org
echo "✅ Restarting Cloudflared service"
sudo systemctl restart cloudflared

echo "✅ Setup completed successfully! 🎉"
