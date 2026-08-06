FROM node:20-bookworm-slim

# better-sqlite3 compiles a native addon
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY cloud/package.json cloud/package-lock.json ./
RUN npm ci --include=dev

COPY cloud/ ./
RUN npm run build

COPY landing_page/ /app/landing_page/
COPY agent-dist/49-agent.tar.gz /app/dl/49-agent.tar.gz

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/tc.db
ENV LANDING_DIR=/app/landing_page

CMD ["node", "src/index.js"]
