FROM node:22-slim

WORKDIR /app

# Install all deps (need typescript for build)
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
COPY config/ ./config/
COPY tools/ ./tools/
RUN npm run build

# Copy non-TS assets that tsc doesn't emit
COPY src/db/schema.sql ./dist/db/schema.sql

# Keep tsx available for tools/fireflies.ts and MCP server
# (npm prune --omit=dev removes tsx, so we keep it)
RUN npm prune --omit=dev && npm install tsx

# Data directory — mount a Railway volume here for persistence
ENV DATA_DIR=/data
RUN mkdir -p /data

CMD ["node", "dist/cli/index.js", "start"]
