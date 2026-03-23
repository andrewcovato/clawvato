#!/bin/bash
# PostToolUse hook — runs after every slack_reply call.
# Extracts facts from the conversation and stores them to memory.
#
# Receives JSON on stdin with tool_input (the Slack message CC just sent).
# Runs asynchronously (async: true in hooks config) so it doesn't block CC.
#
# Uses our existing Haiku extraction pipeline via a small Node.js script.

set -e

# Read hook input from stdin
INPUT=$(cat)

# Extract the message text that CC just sent to Slack
MESSAGE_TEXT=$(echo "$INPUT" | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString());
      // tool_input contains the slack_reply arguments
      const text = data.tool_input?.text || '';
      process.stdout.write(text);
    } catch { process.exit(0); }
  });
")

# Skip extraction for very short messages (reactions, acknowledgments)
if [ ${#MESSAGE_TEXT} -lt 50 ]; then
  exit 0
fi

# Run extraction via our existing pipeline
cd /app
exec npx tsx scripts/extract-from-reply.ts "$MESSAGE_TEXT"
