#!/usr/bin/env bash
# PreToolUse hook — gates gbs-ledger write tools to #clawvato-finance only.
#
# Writes (classify, reclassify, apply_*) are fail-closed: blocked unless the
# active Slack channel (written by src/cc-native/slack-channel.ts on each
# event dispatch) matches $FINANCE_CHANNEL_ID.
#
# Stdin: Claude Code PreToolUse JSON (tool_name, tool_input, session_id, …)
# Stdout: JSON decision ({"decision":"block","reason":"..."}) or empty = allow
# Exit 0 always — non-zero would surface as a hook error, not a clean block.

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')

# Only gate gbs-ledger-write JE-mutating tools. `detect_transfer_pairs` is
# read-like (populates pair suggestions, no JE mutation) and stays open.
# Server-side scope enforcement is the primary defense — this hook is a
# client-side channel gate that runs BEFORE the HTTP call is made.
case "$TOOL_NAME" in
  mcp__gbs-ledger-write__classify \
  |mcp__gbs-ledger-write__reclassify \
  |mcp__gbs-ledger-write__apply_internal_transfer \
  |mcp__gbs-ledger-write__apply_intercompany)
    ;;
  *)
    exit 0
    ;;
esac

block() {
  local reason="$1"
  jq -n --arg r "$reason" '{decision: "block", reason: $r}'
  exit 0
}

# Resolve finance channel ID: cached file (written by slack-channel.ts at boot)
# takes precedence over the FINANCE_CHANNEL_ID env var. Both are optional;
# fail-closed when neither is available.
FINANCE_FILE="${CC_FINANCE_CHANNEL_FILE:-/tmp/cc-finance-channel-id}"
FINANCE_ID=""
if [ -f "$FINANCE_FILE" ]; then
  FINANCE_ID=$(cat "$FINANCE_FILE" 2>/dev/null || printf '')
fi
if [ -z "$FINANCE_ID" ]; then
  FINANCE_ID="${FINANCE_CHANNEL_ID:-}"
fi

if [ -z "$FINANCE_ID" ]; then
  block "GBS Ledger write tool '$TOOL_NAME' blocked: #clawvato-finance channel ID is unresolved (neither $FINANCE_FILE nor FINANCE_CHANNEL_ID env var set). Ensure the bot is a member of #clawvato-finance and restart."
fi

ACTIVE_CHANNEL_FILE="${CC_ACTIVE_CHANNEL_FILE:-/tmp/cc-active-channel}"
if [ ! -f "$ACTIVE_CHANNEL_FILE" ]; then
  block "GBS Ledger write tool '$TOOL_NAME' blocked: no active Slack channel context (file $ACTIVE_CHANNEL_FILE missing). These tools can only run in response to a message in #clawvato-finance."
fi

ACTIVE_CHANNEL=$(cat "$ACTIVE_CHANNEL_FILE" 2>/dev/null || printf '')

if [ "$ACTIVE_CHANNEL" != "$FINANCE_ID" ]; then
  block "GBS Ledger write tool '$TOOL_NAME' is restricted to #clawvato-finance. Current channel: ${ACTIVE_CHANNEL:-(unknown)}. Ask the owner to run this in #clawvato-finance, or propose the action and let them confirm there."
fi

# Allowed: exit 0 with no output = implicit allow.
exit 0
