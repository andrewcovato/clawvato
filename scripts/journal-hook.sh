#!/bin/bash
# PostToolUse hook — conversation journaling.
#
# Accumulates tool call context into a rolling journal file.
# Every JOURNAL_INTERVAL tool calls, sends the journal to the plugin
# for extraction via ingest_conversation.
#
# Runs async (doesn't block CC). Lightweight — just appends text + occasional HTTP call.

JOURNAL_FILE="/tmp/clawvato-journal.md"
COUNTER_FILE="/tmp/clawvato-journal-counter"
JOURNAL_INTERVAL="${CLAWVATO_JOURNAL_INTERVAL:-20}"

# Read hook input from stdin
INPUT=$(cat)

# Extract tool name and key content
TOOL_NAME=$(echo "$INPUT" | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString());
      process.stdout.write(data.tool_name || 'unknown');
    } catch { process.stdout.write('unknown'); }
  });
")

# Skip noisy/low-value tools
case "$TOOL_NAME" in
  Read|Glob|Grep|LS|TaskCreate|TaskUpdate|TaskGet|TaskList|TaskOutput)
    exit 0
    ;;
esac

# Extract a summary of the tool interaction
SUMMARY=$(echo "$INPUT" | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString());
      const name = data.tool_name || 'unknown';
      const input = data.tool_input || {};
      const response = String(data.tool_response || '').slice(0, 500);

      // Format based on tool type
      let summary = '';
      if (name === 'Edit' || name === 'Write') {
        summary = name + ': ' + (input.file_path || 'unknown file');
      } else if (name === 'Bash') {
        summary = 'Bash: ' + (input.command || '').slice(0, 200);
        if (response) summary += '\\nOutput: ' + response.slice(0, 300);
      } else if (name.startsWith('mcp__clawvato-memory__')) {
        summary = name.replace('mcp__clawvato-memory__', 'memory:') + ' ' + JSON.stringify(input).slice(0, 300);
        if (response) summary += '\\nResult: ' + response.slice(0, 300);
      } else {
        summary = name + ': ' + JSON.stringify(input).slice(0, 200);
        if (response) summary += '\\nResult: ' + response.slice(0, 200);
      }

      process.stdout.write(summary);
    } catch { process.exit(0); }
  });
")

# Skip empty summaries
if [ -z "$SUMMARY" ]; then
  exit 0
fi

# Append to journal
echo "---" >> "$JOURNAL_FILE"
echo "[$(date -u +%H:%M)] $SUMMARY" >> "$JOURNAL_FILE"

# Increment counter
COUNT=0
if [ -f "$COUNTER_FILE" ]; then
  COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

# Check if it's time to flush
if [ "$COUNT" -lt "$JOURNAL_INTERVAL" ]; then
  exit 0
fi

# Time to flush — send journal to plugin for extraction
JOURNAL_CONTENT=$(cat "$JOURNAL_FILE" 2>/dev/null)
JOURNAL_SIZE=${#JOURNAL_CONTENT}

if [ "$JOURNAL_SIZE" -lt 100 ]; then
  # Too little content — reset counter but keep accumulating
  echo "0" > "$COUNTER_FILE"
  exit 0
fi

# Determine plugin URL and auth
PLUGIN_URL="${CLAWVATO_MEMORY_URL:-https://clawvato-memory-production.up.railway.app}"
AUTH_TOKEN="${MCP_AUTH_TOKEN}"

if [ -z "$AUTH_TOKEN" ]; then
  exit 0
fi

SURFACE="${CLAWVATO_SURFACE:-local}"
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
SOURCE="journal:${SURFACE}:${SESSION_ID}"

# Send to plugin via direct HTTP (not MCP — simpler, no SSE needed)
# Write JSON payload to a temp file to avoid shell escaping issues
PAYLOAD_FILE="/tmp/clawvato-journal-payload-$$.json"
node -e "
  const fs = require('fs');
  const text = fs.readFileSync('/tmp/clawvato-journal.md', 'utf8');
  const payload = { text, source: process.argv[1], surface_id: process.argv[2] };
  fs.writeFileSync(process.argv[3], JSON.stringify(payload));
" "$SOURCE" "$SURFACE" "$PAYLOAD_FILE"

# Reset journal and counter BEFORE the async send (payload is in the temp file)
> "$JOURNAL_FILE"
echo "0" > "$COUNTER_FILE"

# Send async — curl reads payload file, then cleans up
(curl -s -X POST "${PLUGIN_URL}/ingest" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -d @"$PAYLOAD_FILE" \
  > /dev/null 2>&1; rm -f "$PAYLOAD_FILE") &

exit 0
