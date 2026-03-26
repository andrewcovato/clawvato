#!/usr/bin/env bash
# Fetch Handoff — SessionStart hook script.
#
# Called automatically on every CC session start. Fetches the handoff
# and cross-surface briefs from the memory plugin, outputs them as
# context that CC sees before the first user interaction.
#
# Output format: JSON with hookSpecificOutput.additionalContext
# (SessionStart hooks inject additionalContext into CC's context)
#
# Requires: MCP_AUTH_TOKEN, CLAWVATO_MEMORY_URL, CLAWVATO_SURFACE

set -euo pipefail

MEMORY_URL="${CLAWVATO_MEMORY_URL:-https://brain-platform-production.up.railway.app}"
AUTH_TOKEN="${MCP_AUTH_TOKEN:-}"
SURFACE="${CLAWVATO_SURFACE:-local}"

if [ -z "$AUTH_TOKEN" ]; then
  exit 0  # No token — skip silently
fi

AUTH="Authorization: Bearer ${AUTH_TOKEN}"
CT="Content-Type: application/json"
ACC="Accept: application/json, text/event-stream"

# Fetch handoff for this surface
HANDOFF_RAW=$(curl -s --max-time 5 -X POST "${MEMORY_URL}/mcp" \
  -H "$AUTH" -H "$CT" -H "$ACC" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"get_handoff\",\"arguments\":{\"surface\":\"${SURFACE}\"}}}" 2>/dev/null || echo "")

# Fetch briefs from all surfaces
BRIEFS_RAW=$(curl -s --max-time 5 -X POST "${MEMORY_URL}/mcp" \
  -H "$AUTH" -H "$CT" -H "$ACC" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_briefs\",\"arguments\":{}}}" 2>/dev/null || echo "")

# Extract text content from SSE responses
# Format: "event: message\ndata: {jsonrpc result}\n\n"
extract_text() {
  echo "$1" | grep '^data: ' | sed 's/^data: //' | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    texts = data.get('result', {}).get('content', [])
    for t in texts:
        if t.get('type') == 'text':
            print(t['text'])
except:
    pass
" 2>/dev/null || echo ""
}

HANDOFF=$(extract_text "$HANDOFF_RAW")
BRIEFS=$(extract_text "$BRIEFS_RAW")

# If nothing found, exit silently
if [ -z "$HANDOFF" ] && [ -z "$BRIEFS" ]; then
  exit 0
fi

# Build the context to inject
CONTEXT=""

if [ -n "$HANDOFF" ]; then
  CONTEXT="${CONTEXT}## Session Handoff (surface: ${SURFACE})

You are resuming after a previous session on this surface. Below is the handoff
from your last session. Use it to continue seamlessly — do NOT ask the user to
\"get you up to speed.\" You already have the context. Just continue working.

${HANDOFF}

"
fi

if [ -n "$BRIEFS" ]; then
  CONTEXT="${CONTEXT}## Cross-Surface Briefs

Other surfaces have been active. Here is what they are working on:

${BRIEFS}
"
fi

# Output as SessionStart hook JSON
python3 -c "
import json, sys
context = sys.stdin.read()
output = {
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': context
    }
}
print(json.dumps(output))
" <<< "$CONTEXT"
