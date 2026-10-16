#!/command/with-contenv sh
set -eu
mkdir -p /home/agent/.omp
chown hermes:hermes /home/agent
chown -R hermes:hermes /home/agent/.omp
python3 /opt/subscription.py
s6-setuidgid hermes /opt/install-runtime-tools.sh || echo "runtime tools: install failed; continuing" >&2
