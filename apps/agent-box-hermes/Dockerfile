# syntax=docker/dockerfile:1.7
# Adapted from the allowlisted mindi-stack b5ac82d Dockerfile; see docs/extraction-provenance.md.
FROM nousresearch/hermes-agent:v2026.8.18@sha256:22e37bb4ed1b0f50cb6bd991dca7ecacd6c9f29df9b4a20fc989d32bc763ccf6
USER root
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64 \
 && apt-get update && apt-get install -y --no-install-recommends \
    sway grim wtype wl-clipboard foot xwayland dbus at-spi2-core \
    fonts-dejavu-core fonts-noto-color-emoji wayvnc novnc websockify nginx openssl \
 && apt-get purge -y sudo openssh-server \
 && rm -rf /var/lib/apt/lists/* /etc/s6-overlay/s6-rc.d /etc/cont-init.d \
 && usermod -u 1000 -d /home/agent hermes && groupmod -g 1000 hermes \
 && install -d -o hermes -g hermes /home/agent
# Isolated dependency graph; pg0 0.14.0 bundles PostgreSQL and pgvector.
# Hindsight migrations select psycopg 3, which its slim package does not declare.
# Construct the migration engine at build time to verify the driver can load.
RUN python3 -m venv /opt/hindsight \
 && /opt/hindsight/bin/pip install --no-cache-dir 'hindsight-api-slim[embedded-db]==0.6.1' 'pg0-embedded==0.14.0' 'psycopg[binary]==3.2.10' \
 && /opt/hindsight/bin/python -c "from sqlalchemy import create_engine; create_engine('postgresql+psycopg://localhost/hindsight')"
# No remote installer execution. Release asset SHA256 from GitHub release metadata.
RUN curl -fsSL --retry 3 https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.30.1/cua-driver-rs-0.30.1-linux-x86_64-binary.tar.gz -o /tmp/cua.tar.gz \
 && echo '82411700ae43fa34f6263eb603866c77d4e25e5556ffa03d92cd79cbab9472a2  /tmp/cua.tar.gz' | sha256sum -c - \
 && tar -xzf /tmp/cua.tar.gz -C /usr/local/bin cua-driver \
 && chmod 755 /usr/local/bin/cua-driver && rm /tmp/cua.tar.gz
ENV HOME=/home/agent USER=hermes HERMES_HOME=/home/agent/.hermes \
    HERMES_PROFILE=default HERMES_WRITE_SAFE_ROOT=/home/agent \
    HERMES_LAZY_INSTALL_TARGET=/home/agent/.hermes/lazy-packages \
    XDG_RUNTIME_DIR=/run/user/1000 XDG_SESSION_TYPE=wayland \
    WAYLAND_DISPLAY=wayland-1 SWAYSOCK=/run/user/1000/sway-ipc.sock DISPLAY=:0 \
    WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    CUA_DRIVER_RS_ENABLE_WAYLAND=1 CUA_DRIVER_RS_TELEMETRY_ENABLED=0 GTK_A11Y=atspi \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 S6_KILL_GRACETIME=10000
COPY apps/agent-box-hermes/runtime/ /opt/agent-box/
COPY apps/agent-box-hermes/desktop/ /etc/agent-box/
COPY apps/agent-box-hermes/defaults/persona/AGENTS.md /opt/agent-box/AGENTS.md
COPY apps/agent-box-hermes/s6-rc.d/ /etc/s6-overlay/s6-rc.d/
COPY --chmod=755 apps/agent-box-hermes/cont-init.d/ /etc/cont-init.d/
# s6's built-in top bundle requires both user and user2, even when user2 is empty.
# Compile at build time so missing bundles/dependencies fail before publishing an image.
RUN mkdir -p /etc/s6-overlay/s6-rc.d/user2/contents.d \
 && find /etc/s6-overlay/s6-rc.d -name run -exec chmod 755 {} + \
 && /command/s6-rc-compile /tmp/agent-box-s6-db \
      /etc/s6-overlay/s6-rc.d /package/admin/s6-overlay/etc/s6-rc/sources \
 && rm -rf /tmp/agent-box-s6-db
WORKDIR /home/agent
EXPOSE 8443
VOLUME ["/home/agent", "/var/lib/agent-box/hindsight"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s CMD ["/command/s6-setuidgid", "hermes", "python3", "/opt/agent-box/health.py"]
ENTRYPOINT ["/init"]
CMD []
