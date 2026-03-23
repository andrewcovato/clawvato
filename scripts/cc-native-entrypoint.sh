#!/usr/bin/env bash
# CC-Native Engine — Supervisor Entrypoint
#
# Runs Claude Code in a restart loop with the Slack Channel and Memory MCP servers.
# When CC exits (idle timeout, crash, planned reset), waits briefly and restarts.
#
# Environment variables (required):
#   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, OWNER_SLACK_USER_ID
#   CLAUDE_CODE_OAUTH_TOKEN (Max plan auth)
#   DATABASE_URL (Postgres)
#
# Environment variables (optional):
#   CC_IDLE_TIMEOUT_MS  — Idle timeout in ms (default: 1800000 = 30 min)
#   CC_RESTART_DELAY    — Seconds to wait before restart (default: 5)
#   CC_MAX_TURNS        — Max turns per session (default: 200)
#   DATA_DIR            — Data directory (default: /data)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

RESTART_DELAY="${CC_RESTART_DELAY:-5}"
MAX_TURNS="${CC_MAX_TURNS:-200}"
SESSION_COUNTER=0

echo "[supervisor] CC-Native Engine starting"
echo "[supervisor] Project dir: $PROJECT_DIR"
echo "[supervisor] Idle timeout: ${CC_IDLE_TIMEOUT_MS:-1800000}ms"
echo "[supervisor] Restart delay: ${RESTART_DELAY}s"

# ── Ensure Claude CLI auth is set up ──
if [ -n "${DATA_DIR:-}" ] && [ -d "$DATA_DIR" ]; then
  # Symlink .claude to persistent volume (same as docker-entrypoint.sh)
  if [ -d "$DATA_DIR/claude-config" ]; then
    ln -sfn "$DATA_DIR/claude-config" "$HOME/.claude"
  fi
fi

# Ensure onboarding is complete
mkdir -p "$HOME/.claude"
if [ ! -f "$HOME/.claude/.claude.json" ]; then
  echo '{"hasCompletedOnboarding":true}' > "$HOME/.claude/.claude.json"
fi

# ── Unpack GWS config if provided ──
if [ -n "${GWS_CONFIG_B64:-}" ]; then
  mkdir -p "$HOME/.config/gws"
  echo "$GWS_CONFIG_B64" | base64 -d | tar xzf - -C "$HOME/.config/gws/"
  echo "[supervisor] GWS config unpacked"
fi

# ── Build environment for CC ──
# Allowlist: CC and its channel server need these
export SLACK_BOT_TOKEN
export SLACK_APP_TOKEN
export OWNER_SLACK_USER_ID
export CLAUDE_CODE_OAUTH_TOKEN
export DATABASE_URL
export CC_IDLE_TIMEOUT_MS="${CC_IDLE_TIMEOUT_MS:-1800000}"
export FIREFLIES_API_KEY="${FIREFLIES_API_KEY:-}"
export GOOGLE_AGENT_EMAIL="${GOOGLE_AGENT_EMAIL:-}"
export GWS_CONFIG_B64="${GWS_CONFIG_B64:-}"
export DATA_DIR="${DATA_DIR:-/data}"
export TZ="${TZ:-America/New_York}"

# Do NOT export ANTHROPIC_API_KEY — force CC to use Max plan OAuth
unset ANTHROPIC_API_KEY 2>/dev/null || true

# ── Start task scheduler in background ──
# The scheduler polls for due tasks and posts to Slack.
# CC picks them up as channel events.
echo "[supervisor] Starting task scheduler sidecar"
npx tsx src/cc-native/task-scheduler-standalone.ts &
SCHEDULER_PID=$!
echo "[supervisor] Task scheduler PID: $SCHEDULER_PID"

# ── Cleanup on exit ──
cleanup() {
  echo "[supervisor] Shutting down..."
  kill "$SCHEDULER_PID" 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# ── Restart loop ──
while true; do
  SESSION_COUNTER=$((SESSION_COUNTER + 1))
  echo "[supervisor] Starting CC session #$SESSION_COUNTER"

  # Run Claude Code with channels in interactive mode.
  # `script` provides a pseudo-TTY so CC runs interactively on headless Railway.
  # Without it, CC falls back to --print mode (one-shot, no channel support).
  # --dangerously-load-development-channels: required for custom channels (research preview)
  # --mcp-config: memory + slack-channel servers
  # --append-system-prompt-file: our system prompt
  # --max-turns: prevent runaway sessions
  # --allowedTools: pre-approve tools so CC doesn't hang waiting for permission
  script -qfc "claude \
    --dangerously-load-development-channels server:slack-channel \
    --mcp-config '$PROJECT_DIR/.cc-native-mcp.json' \
    --append-system-prompt-file '$PROJECT_DIR/config/prompts/cc-native-system.md' \
    --max-turns $MAX_TURNS \
    --model claude-opus-4-6 \
    --allowedTools \
      'Bash(gws:*)' 'Bash(npx:*)' 'Bash(cat:*)' 'Bash(ls:*)' 'Bash(echo:*)' 'Bash(mkdir:*)' \
      Read Write Glob Grep Agent \
      WebSearch WebFetch \
      mcp__memory__search_memory mcp__memory__store_fact \
      mcp__memory__retrieve_context mcp__memory__update_working_context \
      mcp__memory__list_tasks mcp__memory__create_task \
      mcp__memory__update_task mcp__memory__delete_task \
      mcp__slack-channel__slack_reply mcp__slack-channel__slack_react \
      mcp__slack-channel__slack_get_history" /dev/null \
    || true  # Don't exit the loop on CC crash

  EXIT_CODE=$?
  echo "[supervisor] CC session #$SESSION_COUNTER exited (code: $EXIT_CODE)"
  echo "[supervisor] Restarting in ${RESTART_DELAY}s..."
  sleep "$RESTART_DELAY"
done
