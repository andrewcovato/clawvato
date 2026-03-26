#!/usr/bin/env bash
# CC-Native Engine — Supervisor Entrypoint
#
# Runs Claude Code in a restart loop with the Slack Channel MCP server.
# Memory is provided by the brain-platform HTTP MCP server (separate Railway service).
# When CC exits (idle timeout, crash, planned reset), waits briefly and restarts.
#
# Environment variables (required):
#   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, OWNER_SLACK_USER_ID
#   CLAUDE_CODE_OAUTH_TOKEN (Max plan auth)
#   DATABASE_URL (Postgres — for task scheduler sidecar)
#   MCP_AUTH_TOKEN (auth for the memory MCP server)
#
# Environment variables (optional):
#   CC_IDLE_TIMEOUT_MS  — Idle timeout in ms (default: 1800000 = 30 min)
#   CC_RESTART_DELAY    — Seconds to wait before restart (default: 5)
#   CC_MAX_TURNS        — Max turns per session (default: 200)
#   DATA_DIR            — Data directory (default: /data)
#   CLAWVATO_MEMORY_INTERNAL_URL — Brain platform MCP URL (default: http://brain-platform.railway.internal:8100/mcp)

set -euo pipefail

# Verify required tools
command -v expect || { echo "expect is required but not installed"; exit 1; }

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
export MCP_AUTH_TOKEN="${MCP_AUTH_TOKEN:-}"

# ── Generate MCP config with auth token ──
# The memory MCP server runs as a separate Railway service (HTTP transport).
# We template the config at runtime to inject the auth token from env vars.
MEMORY_URL="${CLAWVATO_MEMORY_INTERNAL_URL:-http://brain-platform.railway.internal:8100/mcp}"
MCP_CONFIG="/tmp/cc-native-mcp.json"
OLD_UMASK=$(umask)
umask 077
cat > "$MCP_CONFIG" <<MCPJSON
{
  "mcpServers": {
    "brain-platform": {
      "type": "http",
      "url": "${MEMORY_URL}",
      "headers": {
        "Authorization": "Bearer ${MCP_AUTH_TOKEN}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json"
      }
    },
    "slack-channel": {
      "command": "npx",
      "args": ["tsx", "src/cc-native/slack-channel.ts"],
      "env": {
        "LOG_DESTINATION": "stderr"
      }
    }
  }
}
MCPJSON
umask "$OLD_UMASK"
chmod 600 "$MCP_CONFIG"  # defense-in-depth
echo "[supervisor] MCP config written to $MCP_CONFIG"

# Do NOT export ANTHROPIC_API_KEY — force CC to use Max plan OAuth.
# Brain-platform handles extraction server-side via its own ANTHROPIC_API_KEY.
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
  rm -f "$MCP_CONFIG"
  exit 0
}
trap cleanup SIGTERM SIGINT

# ── Restart loop ──
while true; do
  SESSION_COUNTER=$((SESSION_COUNTER + 1))
  echo "[supervisor] Starting CC session #$SESSION_COUNTER"

  # Log rotation — keep only the last 5 session logs
  LOG_RETENTION=5
  for old_log in $(ls -1t /tmp/cc-session-*.log 2>/dev/null | tail -n +$((LOG_RETENTION + 1))); do
    echo "[supervisor] Removing old log: $old_log"
    rm -f "$old_log"
  done

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

  # Use `expect` to run CC with a proper PTY and auto-approve prompts.
  # expect creates a real PTY (not a pipe hack), watches for specific text,
  # and sends the right input. Once trust is persisted on the Railway volume,
  # subsequent restarts skip the prompt automatically.
  CC_LOG="/tmp/cc-session-${SESSION_COUNTER}.log"

  export MCP_CONFIG  # Make available to expect via $env(MCP_CONFIG)

  expect << 'EXPECT_SCRIPT' 2>&1 | tee "$CC_LOG" >&2
    set timeout 120
    log_user 1

    spawn env HOME=/home/clawvato claude \
      --dangerously-skip-permissions \
      --dangerously-load-development-channels server:slack-channel \
      --mcp-config $env(MCP_CONFIG) \
      --append-system-prompt-file /app/config/prompts/cc-native-system.md \
      --max-turns 200 \
      --model claude-opus-4-6

    # CC's TUI (ink) inserts ANSI cursor-movement codes between characters.
    # Raw output looks like: [1Ctrust[1Cthis[1Cfolder
    # Use -re (regex) to match through the ANSI noise.
    #
    # Two prompts may appear in sequence:
    # 1. Trust prompt: "Is this a project you created or one you trust?"
    # 2. Dev channels prompt: "Loading development channels" warning
    # Both have option 1 pre-selected — just send Enter.
    #
    # We loop with exp_continue to catch both prompts within the timeout window.
    set timeout 60

    expect {
      -re "trust.*folder|folder.*trust" {
        # Trust prompt — option 1 is pre-selected, send Enter
        sleep 1
        send "\r"
        exp_continue
      }
      -re "local.*development|development.*channels" {
        # Dev channels warning — option 1 is pre-selected, send Enter
        sleep 1
        send "\r"
        exp_continue
      }
      -re "Y/n" {
        send "Y\r"
        exp_continue
      }
      -re "Enter to confirm" {
        # Generic confirmation prompt — send Enter
        sleep 1
        send "\r"
        exp_continue
      }
      timeout {
        # No more prompts — CC is past startup
      }
    }

    # CC is now past prompts and running with channels.
    # Wait indefinitely for it to exit.
    set timeout -1
    expect eof
EXPECT_SCRIPT

  true  # Don't exit the loop on CC crash

  EXIT_CODE=$?
  echo "[supervisor] CC session #$SESSION_COUNTER exited (code: $EXIT_CODE)"
  echo "[supervisor] Restarting in ${RESTART_DELAY}s..."
  sleep "$RESTART_DELAY"
done
