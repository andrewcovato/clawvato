#!/usr/bin/env bash
# Crawl Sidecar Entrypoint
#
# Runs the standalone sidecar (task poller + master crawl + urgency check).
# NO CoS, no expect loop, no interactive Claude Code session.
# This is a separate Railway service with its own container and logs.
#
# The master crawl spawns ephemeral `claude --print` sessions for the actual crawl.
# These need the same auth setup as the CoS, so we reuse docker-entrypoint.sh's
# auth provisioning but override the final start command.
#
# Required env vars: same as cc-native-entrypoint.sh
#   DATABASE_URL, SLACK_BOT_TOKEN, OWNER_SLACK_USER_ID
#   CLAUDE_CODE_OAUTH_TOKEN, MCP_AUTH_TOKEN
#   CANVAS_ID, MONITORING_CHANNEL_ID

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

export HOME="/home/clawvato"
export TZ="${TZ:-America/New_York}"

echo "[sidecar] Crawl Sidecar starting"
echo "[sidecar] HOME: $HOME"
echo "[sidecar] TZ: $TZ"

# ── Generate MCP config for brain-platform ──
MEMORY_URL="${CLAWVATO_MCP_URL:-http://brain-platform.railway.internal:8100/mcp}"
export MCP_CONFIG="/tmp/cc-native-mcp.json"
OLD_UMASK=$(umask)
umask 077
cat > "$MCP_CONFIG" <<MCPJSON
{
  "mcpServers": {
    "brain-platform": {
      "type": "http",
      "url": "${MEMORY_URL}",
      "headers": {
        "Authorization": "Bearer ${MCP_AUTH_TOKEN:-}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json"
      }
    }
  }
}
MCPJSON
umask "$OLD_UMASK"
chmod 600 "$MCP_CONFIG"
echo "[sidecar] MCP config written to $MCP_CONFIG"

# Strip API key — force claude --print to use Max plan OAuth ($0)
unset ANTHROPIC_API_KEY 2>/dev/null || true

# Export env vars for the sidecar process
export SLACK_BOT_TOKEN
export SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-}"
export OWNER_SLACK_USER_ID
export CLAUDE_CODE_OAUTH_TOKEN
export DATABASE_URL
export CANVAS_ID="${CANVAS_ID:-}"
export MONITORING_CHANNEL_ID="${MONITORING_CHANNEL_ID:-}"
export FIREFLIES_API_KEY="${FIREFLIES_API_KEY:-}"
export GOOGLE_AGENT_EMAIL="${GOOGLE_AGENT_EMAIL:-}"

echo "[sidecar] CANVAS_ID: ${CANVAS_ID:-not set}"
echo "[sidecar] MONITORING_CHANNEL_ID: ${MONITORING_CHANNEL_ID:-not set}"
echo "[sidecar] MCP_CONFIG: $MCP_CONFIG"
echo "[sidecar] Claude OAuth: ${CLAUDE_CODE_OAUTH_TOKEN:+set}"

# ── Run the sidecar with auto-restart ──
while true; do
  echo "[sidecar] Starting task-scheduler-standalone.ts" >&2
  npx tsx src/cc-native/task-scheduler-standalone.ts 2>&1
  EXIT=$?
  echo "[sidecar] Sidecar exited (code: $EXIT), restarting in 10s..." >&2
  sleep 10
done
