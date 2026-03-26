#!/usr/bin/env bash
# Session End Handoff — safety net for ungraceful exits.
#
# Called by the SessionEnd hook when a CC session exits.
# Posts a minimal brief to the memory plugin via HTTP so other
# surfaces know the session ended. The real handoff should have
# been written by CC before exiting — this is the fallback.
#
# Requires: MCP_AUTH_TOKEN, CLAWVATO_MEMORY_URL (or defaults to public URL)

set -euo pipefail

MEMORY_URL="${CLAWVATO_MEMORY_URL:-https://brain-platform-production.up.railway.app}"
AUTH_TOKEN="${MCP_AUTH_TOKEN:-}"
SURFACE="${CLAWVATO_SURFACE:-local}"

if [ -z "$AUTH_TOKEN" ]; then
  echo "[session-end-handoff] No MCP_AUTH_TOKEN — skipping" >&2
  exit 0
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M')

# Update brief to indicate session ended
BRIEF_CONTENT="Session ended at ${TIMESTAMP}. Check long-term memory for recent facts from this session."

# Escape content for JSON
BRIEF_JSON=$(printf '%s' "$BRIEF_CONTENT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')

curl -s -X POST "${MEMORY_URL}/mcp" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"update_brief\",\"arguments\":{\"surface\":\"${SURFACE}\",\"content\":${BRIEF_JSON}}}}" \
  > /dev/null 2>&1 || true

echo "[session-end-handoff] Brief updated for surface '${SURFACE}'" >&2
