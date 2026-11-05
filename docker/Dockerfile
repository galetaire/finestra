# Finestra — read-only Handshake explorer.
# A tiny Node server that serves the explorer UI and forwards read-only calls
# to the Bob DNS app's node proxy. No third-party dependencies.

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="Finestra" \
      org.opencontainers.image.description="Read-only Handshake explorer for umbrelOS, backed by the Bob DNS node" \
      org.opencontainers.image.source="https://github.com/galetaire/finestra"

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY app/package.json ./
# No dependencies to install, but keep the step so the image is reproducible.
RUN npm install --omit=dev --no-audit --no-fund || true
COPY app/ ./

# Run as the unprivileged "node" user that the base image ships.
USER node

EXPOSE 3000
CMD ["node", "server.js"]
