FROM node:22-slim

# CA certificates — node:22-slim strips them, causing TLS UnknownIssuer errors
# expect — automates interactive programs with proper PTY (trust prompt, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates expect && rm -rf /var/lib/apt/lists/*

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
COPY src/db/schema.pg.sql ./dist/db/schema.pg.sql

# Keep tsx available for tools/fireflies.ts and MCP server
# (npm prune --omit=dev removes tsx, so we keep it)
RUN npm prune --omit=dev && npm install tsx

# Install Claude Code CLI for deep path + gws for Google Workspace access
RUN npm install -g @anthropic-ai/claude-code @googleworkspace/cli || true

# Data directory — mount a Railway volume here for persistence
ENV DATA_DIR=/data
RUN mkdir -p /data

# Create non-root user — required for --dangerously-skip-permissions
# (Claude Code refuses this flag under root for security reasons)
RUN useradd -m -s /bin/bash clawvato && \
    chown -R clawvato:clawvato /app /data

# Copy scripts and cc-native source (needed by tsx at runtime)
COPY --chown=clawvato:clawvato scripts/ /app/scripts/
RUN chmod +x /app/scripts/*.sh

# Copy cc-native MCP config
COPY --chown=clawvato:clawvato .cc-native-mcp.json /app/.cc-native-mcp.json

# NOTE: Don't set USER here — entrypoint needs root to fix /data permissions
# on Railway's volume mount, then drops to clawvato user for CC

# Startup: ensure /data/claude-config exists (volume mounted at runtime, not build time)
# then symlink ~/.claude to it so auth tokens persist across redeploys.
# Also restore .claude.json if missing (Claude CLI needs it for onboarding state).
# ENGINE=cc-native selects the cc-native entrypoint.
CMD ["/app/scripts/docker-entrypoint.sh"]
