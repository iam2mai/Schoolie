# The website. No npm install needed: there are no runtime dependencies,
# and Node 22.18+ runs the TypeScript directly.
FROM node:22-slim

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# Letters and the events cache live in /data. Mount a persistent volume
# there, or they are lost on every deploy.
# TRUST_PROXY=1 because hosts like Fly.io and Render put the app behind an
# HTTPS proxy; the app then reads the client IP and https from its headers.
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOST=0.0.0.0 TRUST_PROXY=1
RUN mkdir -p /data
VOLUME /data
EXPOSE 8080

CMD ["node", "src/server.ts"]
