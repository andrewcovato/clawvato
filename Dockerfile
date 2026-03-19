FROM node:22-slim

# CA certificates — node:22-slim strips them, causing TLS UnknownIssuer errors
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

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

# Install Claude Code CLI for heavy path + gws for Google Workspace access
RUN npm install -g @anthropic-ai/claude-code @googleworkspace/cli || true

# Data directory — mount a Railway volume here for persistence
ENV DATA_DIR=/data
RUN mkdir -p /data

# Startup: ensure /data/claude-config exists (volume mounted at runtime, not build time)
# then symlink ~/.claude to it so auth tokens persist across redeploys.
# Also restore .claude.json if missing (Claude CLI needs it for onboarding state).
COPY scripts/docker-entrypoint.sh /app/scripts/docker-entrypoint.sh
RUN chmod +x /app/scripts/docker-entrypoint.sh

CMD ["/app/scripts/docker-entrypoint.sh"]
