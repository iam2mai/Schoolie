# Build the Next.js app and run it as a standalone server.

# Stage 1 — install dependencies and build.
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run next:build

# Stage 2 — a minimal runtime image holding just the standalone output.
# `output: "standalone"` in next.config.mjs traces the server and its
# dependencies into .next/standalone, so no node_modules install is needed here.
FROM node:22-slim AS runner
WORKDIR /app

# Letters and the events cache live in /data. Mount a persistent volume there,
# or they are lost on every deploy.
# TRUST_PROXY=1 because Fly puts the app behind an HTTPS proxy; the app then
# reads the client IP and https from the forwarded headers.
# TZ keeps "today" and "this Friday" on Melbourne time (servers default to UTC).
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    TRUST_PROXY=1 \
    TZ=Australia/Melbourne

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

RUN mkdir -p /data
VOLUME /data
EXPOSE 8080

CMD ["node", "server.js"]
