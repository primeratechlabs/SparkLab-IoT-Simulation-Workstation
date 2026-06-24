# Sparklab Tier-3 gateway — a minimal WebSocket↔TCP relay with egress hardening.
# Build:  docker build -t sparklab-gateway services/gateway
# Run:    docker run --rm -p 9000:9000 --env-file services/gateway/.env sparklab-gateway
FROM node:22-alpine

WORKDIR /app
# install only runtime deps (ws + tsx); @types/ws is dev-only
COPY package.json ./
RUN npm install --omit=dev --no-package-lock && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

ENV GATEWAY_PORT=9000
EXPOSE 9000
USER node
# tsx runs the TypeScript entry directly; the relay is tiny so on-the-fly compile is fine
CMD ["npx", "--no-install", "tsx", "src/main.ts"]
