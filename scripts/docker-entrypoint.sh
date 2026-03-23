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
# On first deploy: GWS_CONFIG_B64 env var → unpacked to /data/gws-config/ (persistent)
# On subsequent deploys: reads from /data/gws-config/ (env var no longer needed)
# Generate with: cd ~/.config/gws && tar czf - --exclude=cache . | base64 | pbcopy
GWS_PERSIST_DIR="/data/gws-config"
if [ -n "$GWS_CONFIG_B64" ]; then
  # Env var present — unpack and persist to volume
  mkdir -p "$GWS_PERSIST_DIR"
  echo "$GWS_CONFIG_B64" | base64 -d | tar xzf - -C "$GWS_PERSIST_DIR"
  mkdir -p /root/.config/gws
  cp -r "$GWS_PERSIST_DIR"/. /root/.config/gws/
  echo "[entrypoint] gws config restored from GWS_CONFIG_B64 and persisted to $GWS_PERSIST_DIR"
elif [ -d "$GWS_PERSIST_DIR" ] && [ -f "$GWS_PERSIST_DIR/credentials" ]; then
  # No env var but persisted config exists on volume — use it
  mkdir -p /root/.config/gws
  cp -r "$GWS_PERSIST_DIR"/. /root/.config/gws/
  echo "[entrypoint] gws config restored from persistent volume ($GWS_PERSIST_DIR)"
else
  echo "[entrypoint] WARNING: No gws auth configured — gws CLI won't have Google access"
fi

# ── Start the agent ──
if [ "${ENGINE:-hybrid}" = "cc-native" ]; then
  echo "[entrypoint] Starting CC-Native Engine"
  exec /app/scripts/cc-native-entrypoint.sh
else
  exec node dist/cli/index.js start
fi
