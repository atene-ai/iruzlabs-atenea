# syntax=docker/dockerfile:1

# The Atenea gateway (README.md): no dependencies beyond Node itself. Build context is
# this directory:
#   docker build -t atenea-gateway:local gateway
FROM node:24-bookworm-slim

WORKDIR /opt/atenea-gateway
COPY package.json ./
COPY src/ src/

# Inside its own container the gateway listens on every interface; the host publishes
# it on loopback only (docker/compose.server.yml).
ENV NODE_ENV=production \
    GATEWAY_HOST=0.0.0.0

USER node
EXPOSE 13081
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.GATEWAY_PORT || 13081}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/server.js"]

LABEL org.opencontainers.image.title="Atenea gateway" \
      org.opencontainers.image.description="Staff sign-in, permissions and a filtering proxy in front of the Atenea dsh web server" \
      org.opencontainers.image.source="https://github.com/atene-ai/iruzlabs-atenea" \
      org.opencontainers.image.licenses="Apache-2.0"
