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
# gws uses encrypted credentials + encryption key + token cache.
# GWS_CONFIG_B64 = base64 of tar.gz of ~/.config/gws/ directory.
# Generate with: cd ~/.config/gws && tar czf - . | base64 | pbcopy
if [ -n "$GWS_CONFIG_B64" ]; then
  mkdir -p /root/.config/gws
  echo "$GWS_CONFIG_B64" | base64 -d | tar xzf - -C /root/.config/gws
  echo "[entrypoint] gws config restored from GWS_CONFIG_B64"
elif [ -n "$GWS_CREDENTIALS_JSON" ]; then
  # Fallback: plain JSON credentials (may not work with encrypted gws)
  mkdir -p /root/.config/gws
  echo "$GWS_CREDENTIALS_JSON" > /root/.config/gws/credentials.json
  echo "[entrypoint] gws credentials written from GWS_CREDENTIALS_JSON (may not work — prefer GWS_CONFIG_B64)"
else
  echo "[entrypoint] WARNING: No gws auth configured — gws CLI won't have Google access"
fi

# ── Start the agent ──
exec node dist/cli/index.js start
