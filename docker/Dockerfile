# syntax=docker/dockerfile:1

# Build: installs dsh and packs the plugin, then initializes a template DSH_HOME
# (the web profile with ds-bot installed) that the entrypoint copies into /data
# on first start. Build context is the repository root:
#   docker build -f docker/Dockerfile -t ds-bot:local .
FROM node:24-bookworm-slim AS build

ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG DSH_VERSION=0.2.0-rc.2

RUN corepack enable \
    && npm config set registry "$NPM_REGISTRY" --global \
    && COREPACK_NPM_REGISTRY="$NPM_REGISTRY" pnpm config set registry "$NPM_REGISTRY" --global \
    && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
        --allow-scripts=@deepseek-ai/dsh-subprocess-local,node-pty,koffi,@google/genai,protobufjs

COPY ds-bot/ /src/ds-bot/

# ds-bot has no build step at install (client.js is committed), so pack it as-is
# and let `dsh plugin add` set up the web profile from dsh's own template. The
# package is named after its content: the entrypoint installs it into a volume
# seeded by an older image, and a new name is what makes pnpm take the new code.
RUN cd /src/ds-bot \
    && npm pack --pack-destination /tmp \
    && mkdir -p /opt/ds-bot \
    && id="ds-bot-$(sha256sum /tmp/ds-bot-*.tgz | cut -c1-16).tgz" \
    && mv /tmp/ds-bot-*.tgz "/opt/ds-bot/$id" \
    && DSH_HOME=/opt/dsh-template dsh plugin --profile web add "/opt/ds-bot/$id" \
    && printf '%s\n' "$id" > /opt/ds-bot/package-id \
    && cp /opt/ds-bot/package-id /opt/dsh-template/profiles/web/.ds-bot-package

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash git curl ca-certificates \
        python3 python3-pip python3-venv \
        build-essential jq ripgrep unzip zip ffmpeg less procps gosu \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

COPY --from=build /usr/local/ /usr/local/
COPY --from=build /opt/dsh-template /opt/dsh-template
# The packed plugin, pnpm itself (corepack's copy), and pnpm's metadata cache and store
# from the install, so the entrypoint can install it into an existing volume without the
# network when the volume's lockfile asks for nothing more.
COPY --from=build /opt/ds-bot/ /opt/ds-bot/
COPY --from=build /root/.cache/node/corepack /root/.cache/node/corepack
COPY --from=build /root/.cache/pnpm /root/.cache/pnpm
COPY --from=build /root/.local/share/pnpm/store /root/.local/share/pnpm/store
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/docker.patch.yml /opt/ds-bot/docker.patch.yml
# Applied only with ATENEA_SERVER_MODE=1 (behind the Atenea gateway, gateway/).
COPY docker/server.patch.yml /opt/ds-bot/server.patch.yml

ENV DSH_HOME=/data \
    DSH_PERMISSION_MODE=danger-full-access

WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

LABEL org.opencontainers.image.title="DS Bot" \
      org.opencontainers.image.description="A team of long-lived Bots on DeepSeek Harness, served by dsh web" \
      org.opencontainers.image.source="https://github.com/Fei2411/DS-Bot" \
      org.opencontainers.image.licenses="Apache-2.0"
