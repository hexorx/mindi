# syntax=docker/dockerfile:1.7
# Adapted from the allowlisted mindi-stack b5ac82d Dockerfile; see docs/extraction-provenance.md.
# Rebuild the pinned source: the released binary embeds vulnerable x/crypto.
FROM golang:1.26.8-bookworm@sha256:a688600ca24f8a4d3ca77f95b0dd40704a9fc787c826660eb7ba0b641b8b175d AS tailscale
WORKDIR /build/tailscale
RUN curl -fsSL --retry 3 https://github.com/tailscale/tailscale/archive/refs/tags/v1.102.4.tar.gz -o /tmp/tailscale.tar.gz \
 && echo '784b023e825e1cca7b146ac6a7aff08b179d60d10839b51019f315dab426c871  /tmp/tailscale.tar.gz' | sha256sum -c - \
 && tar -xzf /tmp/tailscale.tar.gz --strip-components=1
COPY apps/agent-box-hermes/build/tailscale-go.mod ./go.mod
COPY apps/agent-box-hermes/build/tailscale-go.sum ./go.sum
COPY apps/agent-box-hermes/build/verify_tailscale_no_web.sh /opt/build/verify_tailscale_no_web.sh
ENV GOTOOLCHAIN=local CGO_ENABLED=0
RUN go mod download \
 && go mod verify \
 && go build -mod=readonly -trimpath -tags=ts_kube,ts_package_container,ts_omit_webclient \
      -ldflags='-X tailscale.com/version.longStamp=1.102.4-hex315 -X tailscale.com/version.shortStamp=1.102.4' \
      -o /usr/local/bin/ ./cmd/tailscale ./cmd/tailscaled \
 && go version -m /usr/local/bin/tailscaled | awk '$1 == "dep" && $2 == "golang.org/x/crypto" { if ($3 != "v0.56.0") exit 1; found=1 } END { if (!found) exit 1 }' \
 && sh /opt/build/verify_tailscale_no_web.sh
FROM docker:29.8.1-cli@sha256:018edbc908e08fcc9dbf029c812c34251e9b4719e6f71ca0e5eae2a987d014ca AS dockercli
# pg0 hardcodes localhost in setup and connection URIs; configure every path
# before the database first starts. Build from verified source, preserving v0.15.2.
FROM rust:1.94-bookworm@sha256:4ec71e955e6c08aeb238885083222ddff79d82eb87654a96c76e38e94da1a53b AS pg0
WORKDIR /build/pg0
RUN curl -fsSL --retry 3 https://github.com/vectorize-io/pg0/archive/refs/tags/v0.15.2.tar.gz -o /tmp/pg0.tar.gz \
 && echo 'b999ce0e22c21c776331f125919b3c26aebf98909289c179d9d73712a61cf01e  /tmp/pg0.tar.gz' | sha256sum -c - \
 && tar -xzf /tmp/pg0.tar.gz --strip-components=1 \
 && echo 'fae6b81ff86ae75a3b1b1ce812f7e4ac768427ec6ed0b6475a78fdccf892a5b7  src/main.rs' | sha256sum -c -
# The rolling Ubuntu mirror removed these packages. The snapshot retains the
# exact upstream-pinned bytes; pg0 still verifies both SHA256 checksums.
COPY apps/agent-box-hermes/build/pg0-runtime-libs.patch /tmp/pg0-runtime-libs.patch
COPY apps/agent-box-hermes/build/pg0-private-loopback.patch /tmp/pg0.patch
COPY apps/agent-box-hermes/build/pg0-bundle-hashes.patch /tmp/pg0-bundle-hashes.patch
RUN patch --fuzz=0 -p1 < /tmp/pg0-runtime-libs.patch \
 && patch --fuzz=0 -p1 < /tmp/pg0.patch \
 && patch --fuzz=0 -p1 < /tmp/pg0-bundle-hashes.patch \
 && cargo build --release --locked
FROM nousresearch/hermes-agent:v2026.8.18@sha256:22e37bb4ed1b0f50cb6bd991dca7ecacd6c9f29df9b4a20fc989d32bc763ccf6 AS assembled
USER root
ARG TARGETARCH
COPY apps/agent-box-hermes/build/apt-* /opt/build/apt/
RUN test "$TARGETARCH" = amd64 \
 && /opt/build/apt/apt-install-locked.sh \
 && rm -f /etc/chromium.d/apikeys \
 && test ! -e /etc/chromium.d/apikeys && test ! -L /etc/chromium.d/apikeys \
 && rm -rf /opt/build/apt /var/lib/apt/lists/* /etc/s6-overlay/s6-rc.d /etc/cont-init.d \
 && usermod -u 1000 -d /home/agent hermes && groupmod -g 1000 hermes \
 && install -d -o hermes -g hermes /home/agent
# Replace the vulnerable Debian-built CLI at its actual installed path.
COPY --from=dockercli /usr/local/bin/docker /usr/bin/docker
RUN echo '9c46230f41e4263b3a9d93ae9284722709923c50d138bc64eed2bb6c02af0581  /usr/bin/docker' | sha256sum -c -
# Retain runtime uv/uvx (MCP tools can invoke them), with fixed Rust crates.
RUN curl -fsSL --retry 3 https://github.com/astral-sh/uv/releases/download/0.12.21/uv-x86_64-unknown-linux-gnu.tar.gz -o /tmp/uv.tar.gz \
 && echo '23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0  /tmp/uv.tar.gz' | sha256sum -c - \
 && tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx \
 && rm /tmp/uv.tar.gz
# Fixed installed-tree lock; no lifecycle scripts or floating npm resolution.
COPY apps/agent-box-hermes/build/hermes-node-security.json apps/agent-box-hermes/build/apply_node_security.py apps/agent-box-hermes/build/verify_node_security.mjs apps/agent-box-hermes/build/verify_npm_security.mjs /opt/build/
RUN python3 /opt/build/apply_node_security.py --lock /opt/build/hermes-node-security.json \
 && node /opt/build/verify_node_security.mjs /opt/build/hermes-node-security.json
RUN --network=none node /opt/build/verify_npm_security.mjs
# Keep the inherited project and installed metadata consistent with its relock.
COPY apps/agent-box-hermes/build/hermes-pyproject.toml /opt/hermes/pyproject.toml
COPY apps/agent-box-hermes/build/hermes-uv.lock /opt/hermes/uv.lock
COPY apps/agent-box-hermes/build/hermes-security.lock apps/agent-box-hermes/build/hermes-build-tools.lock /opt/build/
# Ignore inherited /opt/hermes project overrides; install only the locked artifacts.
RUN uv pip install --no-config --python /opt/hermes/.venv/bin/python --no-deps --only-binary=:all: --require-hashes -r /opt/build/hermes-security.lock \
 && uv pip install --no-config --python /opt/hermes/.venv/bin/python --target /opt/build/hermes-build-tools --no-deps --only-binary=:all: --require-hashes -r /opt/build/hermes-build-tools.lock \
 && mkdir /opt/build/hermes-wheel \
 && (cd /opt/hermes && PYTHONPATH=/opt/build/hermes-build-tools .venv/bin/python -c "from setuptools.build_meta import build_editable; build_editable('/opt/build/hermes-wheel')") \
 && uv pip install --no-config --python /opt/hermes/.venv/bin/python --no-deps --no-index /opt/build/hermes-wheel/*.whl \
 && rm -rf /opt/build/hermes-build-tools /opt/build/hermes-wheel \
 && /opt/hermes/.venv/bin/python -c "import importlib.metadata as m; assert m.version('pyjwt') == '2.15.0'; assert m.version('anyio') == '4.14.2'; assert m.version('httpx2') == '2.12.0'; assert m.version('httpcore2') == '2.12.0'; assert m.version('urllib3') == '2.8.0'; assert m.version('tornado') == '6.5.9'"
# The lazy feature registry carries an independent exact pin; align it too.
COPY apps/agent-box-hermes/build/patch_lazy_deps.py apps/agent-box-hermes/build/verify_python_security.py apps/agent-box-hermes/build/verify_p9_security.py /opt/build/
RUN /opt/hermes/.venv/bin/python /opt/build/patch_lazy_deps.py \
 && /opt/hermes/.venv/bin/python /opt/build/verify_python_security.py
# Isolated dependency graph; pg0 0.15.2 bundles PostgreSQL and pgvector.
# Hindsight migrations select psycopg 3, which its slim package does not declare.
# Construct the migration engine at build time to verify the driver can load.
COPY apps/agent-box-hermes/build/patch_hindsight.py /opt/build/patch_hindsight.py
COPY apps/agent-box-hermes/build/hindsight-linux-amd64.lock /opt/build/hindsight-linux-amd64.lock
# Complete resolved CPU-only wheel closure; fail rather than resolve new artifacts.
# Model weights still download on first local-mode boot into the memory volume.
ENV TIKTOKEN_CACHE_DIR=/opt/agent-box/tiktoken-cache LITELLM_LOCAL_MODEL_COST_MAP=True
RUN python3 -m venv /opt/hindsight \
 && /opt/hindsight/bin/pip install --no-cache-dir --no-index --no-deps --only-binary=:all: --require-hashes -r /opt/build/hindsight-linux-amd64.lock \
 && /opt/hindsight/bin/pip check \
 && /opt/hindsight/bin/pip uninstall --yes pip \
 && /opt/hindsight/bin/python -c "import importlib.util; assert importlib.util.find_spec('pip') is None" \
 && /opt/hindsight/bin/python /opt/build/patch_hindsight.py \
 && /opt/hindsight/bin/python -c "from sqlalchemy import create_engine; create_engine('postgresql+psycopg://localhost/hindsight')" \
 && /opt/hindsight/bin/python -c "from sentence_transformers import SentenceTransformer; import torch; assert torch.version.cuda is None"
# Pin tokenizer data separately from wheels; never populate a runtime volume.
COPY docs/third-party/hex240-tokenizer-inputs/ /usr/share/doc/agent-box-hermes/third-party/hex240-tokenizer-inputs/
COPY apps/agent-box-hermes/build/bake_tokenizers.py /opt/build/bake_tokenizers.py
COPY apps/agent-box-hermes/test/offline-tokenizer-probe.py /opt/build/offline-tokenizer-probe.py
RUN /opt/hindsight/bin/python /opt/build/bake_tokenizers.py
# Verify the actual locked wheels as the service user, including caught network attempts.
RUN --network=none /command/s6-setuidgid hermes /opt/hindsight/bin/python /opt/build/offline-tokenizer-probe.py
COPY --from=pg0 /build/pg0/target/release/pg0 /opt/build/pg0
# The SDK prefers its bundled binary over PATH. Replace that exact executable.
RUN /opt/hindsight/bin/python -c "import pathlib, pg0, shutil; target = pathlib.Path(pg0.__file__).parent / 'bin/pg0'; assert target.is_file(); shutil.copy2('/opt/build/pg0', target)" \
 && rm /opt/build/pg0
# No remote installer execution. Release asset SHA256 from GitHub release metadata.
RUN curl -fsSL --retry 3 https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.30.1/cua-driver-rs-0.30.1-linux-x86_64-binary.tar.gz -o /tmp/cua.tar.gz \
 && echo '82411700ae43fa34f6263eb603866c77d4e25e5556ffa03d92cd79cbab9472a2  /tmp/cua.tar.gz' | sha256sum -c - \
 && tar -xzf /tmp/cua.tar.gz -C /usr/local/bin cua-driver \
 && chmod 755 /usr/local/bin/cua-driver && rm /tmp/cua.tar.gz
# Optional userspace Tailscale; disabled unless AGENT_BOX_TAILSCALE=1. No containerboot entrypoint.
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscale /usr/local/bin/
COPY LICENSE /usr/share/doc/agent-box-hermes/LICENSE
# Ship the collected attribution bytes with the image, including explicit gaps.
# Release acceptance still requires the final inventory/source reconciliation.
COPY docs/third-party/hex184-resolution/bundle/ /usr/share/doc/agent-box-hermes/third-party/
COPY docs/third-party/hex198-build-inputs/ /usr/share/doc/agent-box-hermes/third-party/hex198-build-inputs/
COPY docs/third-party/hex195-provenance-join/ /usr/share/doc/agent-box-hermes/third-party/hex195-provenance-join/
COPY docs/third-party/hex214-security-inputs/ /usr/share/doc/agent-box-hermes/third-party/hex214-security-inputs/
COPY docs/third-party/hex232-security-inputs/ /usr/share/doc/agent-box-hermes/third-party/hex232-security-inputs/
COPY docs/third-party/hex290-security-inputs/ /usr/share/doc/agent-box-hermes/third-party/hex290-security-inputs/
COPY docs/third-party/hex276-security-inputs/ /usr/share/doc/agent-box-hermes/third-party/hex276-security-inputs/
COPY docs/third-party/hex263-uv-inputs/ /usr/share/doc/agent-box-hermes/third-party/hex263-uv-inputs/
COPY apps/agent-box-hermes/build/verify_uv_notices.py /opt/build/verify_uv_notices.py
RUN python3 /opt/build/verify_uv_notices.py /usr/share/doc/agent-box-hermes/third-party/hex263-uv-inputs --bin-dir /usr/local/bin
COPY docs/third-party/NOTICE-STATUS.md /usr/share/doc/agent-box-hermes/third-party/NOTICE-STATUS.md
COPY apps/agent-box-hermes/runtime/ /opt/agent-box/
COPY --chmod=755 apps/agent-box-hermes/runtime/claude /usr/local/bin/claude
COPY apps/agent-box-hermes/desktop/ /etc/agent-box/
COPY apps/agent-box-hermes/defaults/ /opt/agent-box/defaults/
COPY apps/agent-box-hermes/s6-rc.d/ /etc/s6-overlay/s6-rc.d/
COPY --chmod=755 apps/agent-box-hermes/cont-init.d/ /etc/cont-init.d/
# s6's built-in top bundle requires both user and user2, even when user2 is empty.
# Compile at build time so missing bundles/dependencies fail before publishing an image.
RUN mkdir -p /etc/s6-overlay/s6-rc.d/user2/contents.d \
 && find /etc/s6-overlay/s6-rc.d -name run -exec chmod 755 {} + \
 && /command/s6-rc-compile /tmp/agent-box-s6-db \
      /etc/s6-overlay/s6-rc.d /package/admin/s6-overlay/etc/s6-rc/sources \
 && rm -rf /tmp/agent-box-s6-db
# Sanitize before the final stage: inherited layers must never be distributed.
COPY apps/agent-box-hermes/build/collect_debian_notices.py apps/agent-box-hermes/build/payload-debian-packages.txt /opt/build/
RUN python3 /opt/build/collect_debian_notices.py
COPY apps/agent-box-hermes/build/sanitize_payloads.py apps/agent-box-hermes/build/verify_payloads.py apps/agent-box-hermes/build/payload-policy.json /opt/build/
RUN python3 /opt/build/sanitize_payloads.py --root / \
      --report /usr/share/doc/agent-box-hermes/third-party/payload-remediation.json \
 && python3 /opt/build/verify_payloads.py --root /

# Require the standalone source commit; an upstream or empty revision mislabels
# the release. Keep validation late so changing only metadata reuses build work.
ARG SOURCE_REVISION
RUN test "${#SOURCE_REVISION}" -eq 40 \
 && case "$SOURCE_REVISION" in *[!0-9a-f]*) exit 1;; esac

FROM scratch AS runtime
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.source="https://github.com/hexorx/mindi" \
      io.hexorx.source-companion.url="https://github.com/hexorx/mindi/releases/tag/hermes-source-${SOURCE_REVISION}"
COPY --from=assembled / /
# Explicitly restore inherited runtime settings after the scratch boundary.
ENV PATH=/opt/hermes/bin:/opt/hermes/.venv/bin:/home/agent/.local/bin:/opt/data/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    npm_config_install_links=false HERMES_WEB_DIST=/opt/hermes/hermes_cli/web_dist \
    HERMES_TUI_DIR=/opt/hermes/ui-tui HERMES_DISABLE_LAZY_INSTALLS=1
ENV TIKTOKEN_CACHE_DIR=/opt/agent-box/tiktoken-cache LITELLM_LOCAL_MODEL_COST_MAP=True
ENV HOME=/home/agent USER=hermes HERMES_HOME=/home/agent/.hermes \
    HERMES_PROFILE=default HERMES_WRITE_SAFE_ROOT=/home/agent \
    HERMES_LAZY_INSTALL_TARGET=/home/agent/.hermes/lazy-packages \
    XDG_RUNTIME_DIR=/run/user/1000 XDG_SESSION_TYPE=wayland \
    WAYLAND_DISPLAY=wayland-1 SWAYSOCK=/run/user/1000/sway-ipc.sock DISPLAY=:0 \
    WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    CUA_DRIVER_RS_ENABLE_WAYLAND=1 CUA_DRIVER_RS_TELEMETRY_ENABLED=0 GTK_A11Y=atspi \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 S6_KILL_GRACETIME=10000
USER root
WORKDIR /home/agent
EXPOSE 8443
VOLUME ["/opt/data", "/home/agent", "/var/lib/agent-box/hindsight"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s CMD ["/command/s6-setuidgid", "hermes", "python3", "/opt/agent-box/health.py"]
ENTRYPOINT ["/init"]
CMD []
