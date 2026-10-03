#!/command/with-contenv sh
set -eu
mkdir -p /home/agent
chown hermes:hermes /home/agent
python3 /opt/subscription.py
