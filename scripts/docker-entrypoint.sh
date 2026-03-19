#!/bin/sh
set -e

# ── Claude CLI auth persistence ──
mkdir -p /data/claude-config /data/claude-config/backups
rm -f /root/.claude
ln -sf /data/claude-config /root/.claude

if [ ! -f /root/.claude.json ]; then
  if [ -f /data/claude-config/.claude.json ]; then
    cp /data/claude-config/.claude.json /root/.claude.json
  else
    echo '{"hasCompletedOnboarding":true}' > /root/.claude.json
  fi
fi

# ── gws (Google Workspace CLI) auth ──
# Set GWS_CREDENTIALS_JSON env var on Railway with output of `gws auth export`
if [ -n "$GWS_CREDENTIALS_JSON" ]; then
  mkdir -p /root/.config/gws
  echo "$GWS_CREDENTIALS_JSON" > /root/.config/gws/credentials.json

  # gws looks for either credentials.json or token_cache.json with the OAuth tokens
  # Write as application default credentials format
  echo "$GWS_CREDENTIALS_JSON" > /root/.config/gws/token_cache.json

  echo "[entrypoint] gws credentials written from GWS_CREDENTIALS_JSON"
else
  echo "[entrypoint] WARNING: GWS_CREDENTIALS_JSON not set — gws CLI won't have Google access"
fi

# ── Start the agent ──
exec node dist/cli/index.js start
