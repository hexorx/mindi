# syntax=docker/dockerfile:1.7
# Agent box — Wayland desktop on the official Hermes image.
# Build from the repo root:
#   docker build -t mindi/agent-box:latest -f infra/agent-box/Dockerfile .

ARG HERMES_IMAGE=nousresearch/hermes-agent:v2026.8.18@sha256:22e37bb4ed1b0f50cb6bd991dca7ecacd6c9f29df9b4a20fc989d32bc763ccf6
ARG WAYVNC_REF=v0.10.1
ARG NEATVNC_REF=v1.0.1
ARG AML_REF=v1.0.0
ARG TAILSCALE_IMAGE=tailscale/tailscale:v1.102.3@sha256:8c42c4574ab066384fcb72f69e086a2ff1dd3652eb6f56856cee34bcf0d2f680

# ---- wayvnc from upstream tags (distro wayvnc lacks RFB security type 2) ----
FROM debian:13.4 AS vnc-builder
ARG WAYVNC_REF
ARG NEATVNC_REF
ARG AML_REF
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates git \
        meson ninja-build pkg-config gcc dpkg-dev \
        libdrm-dev libxkbcommon-dev libwayland-dev \
        libjansson-dev libpam0g-dev libgnutls28-dev \
        libavfilter-dev libavcodec-dev libavutil-dev libturbojpeg0-dev \
        libpixman-1-dev nettle-dev libgmp-dev \
        zlib1g-dev scdoc \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN set -eux \
    && git clone --depth 1 --branch ${AML_REF} https://github.com/any1/aml.git \
    && git clone --depth 1 --branch ${NEATVNC_REF} https://github.com/any1/neatvnc.git \
    && git clone --depth 1 --branch ${WAYVNC_REF} https://github.com/any1/wayvnc.git \
    && sed -i '/ADD_SECURITY_TYPE(RFB_SECURITY_TYPE_APPLE_DH)/d' neatvnc/src/server.c \
    && export PKG_CONFIG_PATH="/usr/lib/pkgconfig:/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)/pkgconfig" \
    && libdir="lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)" \
    && for proj in aml neatvnc wayvnc; do \
         meson setup "$proj/build" "$proj" --prefix=/usr --libdir="$libdir" -Dbuildtype=release \
         && ninja -C "$proj/build" \
         && ninja -C "$proj/build" install \
         && DESTDIR=/out ninja -C "$proj/build" install; \
       done

# Native input-free keyboard/pointer capability holder, using the pinned wayvnc protocol.
COPY infra/agent-box/input-seat.c /src/input-seat.c
RUN wayland-scanner client-header wayvnc/protocols/virtual-keyboard-unstable-v1.xml /src/virtual-keyboard-client-protocol.h \
    && wayland-scanner private-code wayvnc/protocols/virtual-keyboard-unstable-v1.xml /src/virtual-keyboard-protocol.c \
    && wayland-scanner client-header wayvnc/protocols/wlr-virtual-pointer-unstable-v1.xml /src/virtual-pointer-client-protocol.h \
    && wayland-scanner private-code wayvnc/protocols/wlr-virtual-pointer-unstable-v1.xml /src/virtual-pointer-protocol.c \
    && mkdir -p /out/usr/local/bin \
    && cc -Wall -Wextra -Werror -O2 /src/input-seat.c /src/virtual-keyboard-protocol.c /src/virtual-pointer-protocol.c \
         -o /out/usr/local/bin/mindi-input-seat $(pkg-config --cflags --libs wayland-client)

# ---- Ghostty terminal (signed source release; builds natively on linux/amd64) ----
FROM debian:13.4 AS ghostty-builder
ARG GHOSTTY_VERSION=1.3.1
ARG ZIG_VERSION=0.15.2
ARG ZIG_X86_64_LINUX_SHA256=02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gettext \
        libadwaita-1-dev libgtk-4-dev libgtk4-layer-shell-dev \
        libxml2-utils minisign pkg-config xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN set -eux \
    && zig_archive="zig-x86_64-linux-${ZIG_VERSION}.tar.xz" \
    && curl -fsSLO "https://ziglang.org/download/${ZIG_VERSION}/${zig_archive}" \
    && echo "${ZIG_X86_64_LINUX_SHA256}  ${zig_archive}" | sha256sum -c - \
    && mkdir /opt/zig \
    && tar -xf "${zig_archive}" -C /opt/zig --strip-components=1 \
    && ln -s /opt/zig/zig /usr/local/bin/zig \
    && curl -fsSLo ghostty.tar.gz "https://release.files.ghostty.org/${GHOSTTY_VERSION}/ghostty-${GHOSTTY_VERSION}.tar.gz" \
    && curl -fsSLo ghostty.tar.gz.minisig "https://release.files.ghostty.org/${GHOSTTY_VERSION}/ghostty-${GHOSTTY_VERSION}.tar.gz.minisig" \
    && minisign -Vm ghostty.tar.gz -P "RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV" \
    && mkdir ghostty \
    && tar -xf ghostty.tar.gz -C ghostty --strip-components=1 \
    && cd ghostty \
    && DESTDIR=/out zig build --prefix /usr -Doptimize=ReleaseFast -Dcpu=baseline install

# ---- buzz-cli (Hermes native Buzz platform shells out to `buzz`) ----
FROM rust:bookworm AS buzz-cli
RUN apt-get update && apt-get install -y --no-install-recommends \
        git pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 https://github.com/block/buzz.git .
RUN cargo build --release -p buzz-cli \
    && mkdir -p /out \
    && if [ -x target/release/buzz ]; then cp target/release/buzz /out/buzz; \
       else cp target/release/buzz-cli /out/buzz; fi

# ---- Hermes config helpers (TypeScript → ESM) ----
FROM node:20-bookworm-slim AS hermes-config
WORKDIR /src
COPY infra/agent-box/tsconfig.hermes-config.json \
     infra/agent-box/configure-hermes-buzz.ts \
     infra/agent-box/configure-hermes-computer-use.ts \
     infra/agent-box/configure-hermes-hindsight.ts \
     infra/agent-box/configure-hermes-dashboard.ts \
     infra/agent-box/configure-hermes-webhook.ts \
     infra/agent-box/join-link.ts \
     ./
RUN npm init -y >/dev/null \
    && npm install --omit=dev typescript@5.8.3 @types/node@22.15.3 \
    && npx tsc -p tsconfig.hermes-config.json \
    && sed -i -E 's#from "\./configure-hermes-buzz\.(ts|js)"#from "./configure-hermes-buzz.mjs"#' dist/join-link.js

FROM ${TAILSCALE_IMAGE} AS tailscale

# ---- runtime: official Hermes (Debian 13.4, s6-overlay, sealed /opt/hermes) ----
FROM ${HERMES_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/agent \
    USER=hermes \
    HERMES_HOME=/home/agent/.hermes \
    HERMES_UID=1000 \
    HERMES_GID=1000 \
    HERMES_WRITE_SAFE_ROOT=/home/agent \
    HERMES_LAZY_INSTALL_TARGET=/home/agent/.hermes/lazy-packages \
    XDG_RUNTIME_DIR=/run/user/1000 \
    XDG_SESSION_TYPE=wayland \
    WAYLAND_DISPLAY=wayland-1 \
    WLR_BACKENDS=headless \
    WLR_HEADLESS_OUTPUTS=1 \
    WLR_LIBINPUT_NO_DEVICES=1 \
    WLR_RENDERER=pixman \
    DISPLAY=:0 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    CUA_DRIVER_RS_ENABLE_WAYLAND=1 \
    CUA_DRIVER_RS_TELEMETRY_ENABLED=0 \
    GTK_A11Y=atspi
ENV PATH="/opt/hermes/bin:/opt/hermes/.venv/bin:/home/agent/.local/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
        wget unzip jq less gnupg sudo \
        zsh dbus dbus-user-session openssh-server \
        sway grim wtype wl-clipboard thunar mousepad wofi waybar \
        libadwaita-1-0 libegl1 libgl1-mesa-dri libgtk-4-1 libgtk4-layer-shell0 \
        xwayland at-spi2-core libxi6 libxtst6 libatspi2.0-0 libatk-bridge2.0-0 \
        fonts-dejavu-core fonts-noto-color-emoji \
        novnc websockify \
        libdrm2 libjansson4 libpam0g libgnutls30t64 \
        libavfilter10 libavcodec61 libavutil59 libturbojpeg0 \
        libpixman-1-0 libnettle8t64 libgmp10 zlib1g \
        libwayland-client0 libwayland-server0 libxkbcommon0 \
        python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/run/sshd /home/agent \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && usermod -d /home/agent -s /bin/zsh hermes \
    && echo '%hermes ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/hermes \
    && chmod 440 /etc/sudoers.d/hermes \
    && chown hermes:hermes /home/agent

COPY --from=vnc-builder /out/ /
RUN ldconfig

COPY --from=buzz-cli /out/buzz /usr/local/bin/buzz
RUN chmod 755 /usr/local/bin/buzz
# sshd login PATH is /usr/local/bin:/usr/bin:/bin:/usr/games — not container ENV PATH.
RUN ln -sf /opt/hermes/bin/hermes /usr/local/bin/hermes

COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
RUN chmod 755 /usr/local/bin/tailscale /usr/local/bin/tailscaled

RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod 644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update -qq \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Google's apt repo is amd64-only. Worker hosts that run agent boxes are amd64.
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update -qq \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghostty-builder /out/usr/ /usr/

COPY infra/agent-box/google-chrome-wayland.sh /usr/local/bin/google-chrome
RUN chmod 755 /usr/local/bin/google-chrome

RUN sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin \
    && curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh

COPY infra/agent-box/entrypoint.sh infra/agent-box/identity.sh \
     infra/agent-box/identity-watch.sh \
     infra/agent-box/start-herdr.sh \
     infra/agent-box/start-wayvnc.sh \
     infra/agent-box/start-atspi.sh \
     infra/agent-box/start-gateway.sh \
     infra/agent-box/start-hindsight.sh \
     infra/agent-box/start-dashboard.sh \
     infra/agent-box/start-tailscale.sh \
     infra/agent-box/configure-agent-box.sh \
     infra/agent-box/install-herdr-integrations.sh \
     infra/agent-box/buzz-presence.sh \
     /opt/
COPY --from=hermes-config /src/dist/configure-hermes-buzz.js \
     /opt/configure-hermes-buzz.mjs
COPY --from=hermes-config /src/dist/configure-hermes-computer-use.js \
     /opt/configure-hermes-computer-use.mjs
COPY --from=hermes-config /src/dist/configure-hermes-hindsight.js \
     /opt/configure-hermes-hindsight.mjs
COPY --from=hermes-config /src/dist/configure-hermes-dashboard.js \
     /opt/configure-hermes-dashboard.mjs
COPY --from=hermes-config /src/dist/configure-hermes-webhook.js \
     /opt/configure-hermes-webhook.mjs
COPY --from=hermes-config /src/dist/join-link.js \
     /opt/join-link.mjs
COPY infra/agent-box/plugins/ /opt/mindi-plugins/
COPY infra/agent-box/sway/config /etc/agent-box/sway/config
COPY infra/agent-box/waybar/config /etc/xdg/waybar/config
COPY infra/agent-box/waybar/style.css /etc/xdg/waybar/style.css
COPY infra/agent-box/s6-rc.d/ /etc/s6-overlay/s6-rc.d/
COPY infra/agent-box/cont-init.d/ /etc/cont-init.d/
COPY bootfetch.sh /opt/bootfetch.sh
RUN chmod 755 /opt/entrypoint.sh /opt/identity.sh /opt/identity-watch.sh \
        /opt/start-herdr.sh \
        /opt/start-wayvnc.sh \
        /opt/start-atspi.sh \
        /opt/start-gateway.sh \
        /opt/start-hindsight.sh \
        /opt/start-dashboard.sh \
        /opt/start-tailscale.sh \
        /opt/configure-agent-box.sh \
        /opt/install-herdr-integrations.sh \
        /opt/buzz-presence.sh \
        /opt/configure-hermes-buzz.mjs \
        /opt/configure-hermes-computer-use.mjs \
        /opt/configure-hermes-hindsight.mjs \
        /opt/configure-hermes-dashboard.mjs \
        /opt/join-link.mjs \
        /opt/configure-hermes-webhook.mjs \
        /opt/bootfetch.sh \
    && find /etc/s6-overlay/s6-rc.d -name run -exec chmod 755 {} + \
    && chmod 755 /etc/cont-init.d/018-agent-box /etc/cont-init.d/025-agent-box-gateway

USER hermes
WORKDIR /home/agent
RUN curl -fsSL https://herdr.dev/install.sh | sh

USER root
RUN cp /home/agent/.local/bin/herdr /usr/local/bin/herdr
RUN mkdir -p /opt/cua-driver \
    && curl -fsSL https://cua.ai/driver/install.sh | \
         CUA_DRIVER_RS_HOME=/opt/cua-driver \
         CUA_DRIVER_BIN_DIR=/usr/local/bin \
         CUA_DRIVER_NO_MODIFY_PATH=1 \
         bash -s -- --bin-dir /usr/local/bin --no-modify-path \
    && chmod 755 /usr/local/bin/cua-driver \
    && chown -R hermes:hermes /opt/cua-driver /home/agent
RUN python3 -m venv /opt/hindsight \
    && /opt/hindsight/bin/pip install --no-cache-dir \
        "hindsight-api-slim[embedded-db]==0.6.1" \
    && chown -R hermes:hermes /opt/hindsight /opt/mindi-plugins
EXPOSE 9119 6080 22
VOLUME ["/home/agent"]
# Keep official s6 as PID 1: entrypoint.sh execs entrypoint-dispatch.sh after bootfetch.
ENTRYPOINT ["/opt/entrypoint.sh"]
CMD ["sleep", "infinity"]
