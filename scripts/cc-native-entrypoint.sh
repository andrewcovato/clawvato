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

# Force HOME to the clawvato user's home (su -p preserves root's HOME)
export HOME="/home/clawvato"

echo "[supervisor] CC-Native Engine starting"
echo "[supervisor] Project dir: $PROJECT_DIR"
echo "[supervisor] HOME: $HOME"
echo "[supervisor] User: $(whoami)"
echo "[supervisor] Idle timeout: ${CC_IDLE_TIMEOUT_MS:-1800000}ms"
echo "[supervisor] Restart delay: ${RESTART_DELAY}s"

# Auth setup is handled by docker-entrypoint.sh before this script runs.
# Just verify it's in place.
echo "[supervisor] Claude config: $(ls -la $HOME/.claude 2>&1 || echo 'not found')"
echo "[supervisor] OAuth token: ${CLAUDE_CODE_OAUTH_TOKEN:+set}${CLAUDE_CODE_OAUTH_TOKEN:-not set}"

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
  #
  # `script` provides a pseudo-TTY so CC runs interactively on headless Railway.
  # Without it, CC falls back to --print mode (one-shot, no channel support).
  #
  # `--dangerously-skip-permissions` is the official flag for unattended use.
  # It skips the workspace trust prompt AND all tool permission prompts.
  # From the docs: "For unattended use, --dangerously-skip-permissions bypasses
  # prompts entirely, but only use it in environments you trust."
  #
  # Output is logged to /tmp/cc-session.log for debugging.
  #
  CC_LOG="/tmp/cc-session-${SESSION_COUNTER}.log"
  echo "[supervisor] Logging CC output to $CC_LOG"

  # Stream CC output to stderr (Railway logs).
  # script provides the PTY so CC runs in interactive mode.
  #
  # Auto-approve: CC's TUI expects \r (carriage return) for Enter, not \n.
  # Send \r repeatedly starting early to catch the trust prompt whenever
  # it appears. Once trust is persisted (~/.claude/ on volume), subsequent
  # restarts won't need this.
  {
    # Send Enter (\r) every 2s for the first 30s to catch any prompts
    for i in $(seq 1 15); do
      sleep 2
      printf '\r'
    done
    # Keep stdin open so PTY doesn't close
    while true; do sleep 3600; done
  } | script -qfc "claude \
    --dangerously-skip-permissions \
    --dangerously-load-development-channels server:slack-channel \
    --mcp-config '$PROJECT_DIR/.cc-native-mcp.json' \
    --append-system-prompt-file '$PROJECT_DIR/config/prompts/cc-native-system.md' \
    --max-turns $MAX_TURNS \
    --model claude-opus-4-6" /dev/stdout 2>&1 | tee "$CC_LOG" >&2 \
    || true  # Don't exit the loop on CC crash

  EXIT_CODE=$?
  echo "[supervisor] CC session #$SESSION_COUNTER exited (code: $EXIT_CODE)"
  echo "[supervisor] Restarting in ${RESTART_DELAY}s..."
  sleep "$RESTART_DELAY"
done
