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

# Install Claude Code CLI for heavy path
RUN npm install -g @anthropic-ai/claude-code || true

# Data directory — mount a Railway volume here for persistence
ENV DATA_DIR=/data
RUN mkdir -p /data

# Startup: ensure /data/claude-config exists (volume mounted at runtime, not build time)
# then symlink ~/.claude to it so auth tokens persist across redeploys.
# Also restore .claude.json if missing (Claude CLI needs it for onboarding state).
CMD mkdir -p /data/claude-config /data/claude-config/backups && \
    rm -f /root/.claude && \
    ln -sf /data/claude-config /root/.claude && \
    (test -f /root/.claude.json || \
     test -f /data/claude-config/.claude.json && cp /data/claude-config/.claude.json /root/.claude.json || \
     echo '{"hasCompletedOnboarding":true}' > /root/.claude.json) && \
    node dist/cli/index.js start
