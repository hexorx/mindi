# Build from the repository root. The base is built from infra/agent-box/Dockerfile.
ARG AGENT_BOX_IMAGE
FROM node:22-bookworm-slim AS backend-build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/ packages/
COPY apps/backend/ apps/backend/
ARG SOURCE_REVISION=""
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm exec turbo run build --filter=@mindi/backend... \
    && pnpm --filter @mindi/backend deploy --prod --legacy /out/opt/mindi-backend \
    && node apps/backend/dist/write-build-info.js /out/opt/mindi-backend/build-info.json "$SOURCE_REVISION"

# Assemble the runtime tree here so the already-deep desktop base receives one
# COPY layer, including executable modes, rather than one layer per file.
COPY infra/agent-box/start-backend.sh /out/opt/start-backend.sh
COPY infra/agent-box/start-hindsight.sh /out/opt/start-hindsight.sh
COPY infra/backend-box/google-chrome-wayland.sh /out/usr/local/bin/google-chrome
COPY infra/backend-box/s6-rc.d/ /out/etc/s6-overlay/s6-rc.d/
COPY infra/backend-box/subscription.py /out/opt/subscription.py
COPY infra/backend-box/prepare-home.sh /out/etc/cont-init.d/10-backend-home
RUN chmod 755 /out/opt/start-backend.sh /out/usr/local/bin/google-chrome \
    /out/etc/cont-init.d/10-backend-home /out/etc/s6-overlay/s6-rc.d/backend/run \
    /out/opt/start-hindsight.sh /out/etc/s6-overlay/s6-rc.d/hindsight/run

FROM ${AGENT_BOX_IMAGE}
ARG SOURCE_REVISION=""
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
USER root
# /init bypasses the upstream UID remapper. Fix the service identity in the
# image, before any runtime bind mounts exist; never chown operator mounts.
RUN old_uid="$(id -u hermes)" && old_gid="$(id -g hermes)" \
    && groupmod -g 1000 hermes \
    && usermod -u 1000 -g 1000 hermes \
    && find /opt /home -xdev -uid "$old_uid" -exec chown -h 1000 {} + \
    && find /opt /home -xdev -gid "$old_gid" -exec chgrp -h 1000 {} + \
    && test "$(id -u hermes):$(id -g hermes)" = 1000:1000
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) asset=omp-linux-x64; checksum=040c254ddeb30f6d592be67d1469dc67fcac14e933fa04dbf690f42820ffd820 ;; \
      arm64) asset=omp-linux-arm64; checksum=58ab1b8f75d202cf3767e19901c834d2435898a189d5993be6d5cae6736716e1 ;; \
      *) echo "Unsupported OMP architecture" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/can1357/oh-my-pi/releases/download/v18.1.17/$asset" -o /usr/local/bin/omp \
    && printf '%s  %s\n' "$checksum" /usr/local/bin/omp | sha256sum -c - \
    && chmod 755 /usr/local/bin/omp \
    && test "$(omp --version)" = "omp/18.1.17"
RUN npm install --prefix /opt/mindi-native --omit=dev \
      @agentclientprotocol/claude-agent-acp@0.75.1 @anthropic-ai/claude-code@2.1.266
ENV PATH="/opt/mindi-native/node_modules/.bin:${PATH}"
ENV TIKTOKEN_CACHE_DIR=/opt/hindsight-assets/tiktoken
RUN mkdir -p "$TIKTOKEN_CACHE_DIR" \
    && /opt/hindsight/bin/python -c "import tiktoken; tiktoken.get_encoding('cl100k_base'); tiktoken.get_encoding('o200k_base')" \
    && chmod -R a+rX /opt/hindsight-assets
ENV MINDI_CLAUDE_ACP_COMMAND=/opt/mindi-native/node_modules/.bin/claude-agent-acp
# Replace product service definitions; s6-overlay's own base services are retained
# by /init. No Hermes bootstrap or profile dispatcher executes in this target.
RUN rm -rf /etc/cont-init.d /etc/services.d /etc/s6-overlay/s6-rc.d \
    && mkdir -p /etc/cont-init.d /etc/s6-overlay/s6-rc.d
COPY --from=backend-build /out/ /
ENV HOME=/home/agent
WORKDIR /home/agent
ENTRYPOINT ["/init"]
CMD []
