#!/bin/sh
set -e

# ── Fix volume permissions (runs as root, Railway mounts volume as root) ──
chown -R clawvato:clawvato /data 2>/dev/null || true

# ── Set up auth as the clawvato user ──
CLAWVATO_HOME="/home/clawvato"

# Claude CLI auth persistence
mkdir -p /data/claude-config /data/claude-config/backups
rm -f "$CLAWVATO_HOME/.claude"
ln -sf /data/claude-config "$CLAWVATO_HOME/.claude"

if [ ! -f "$CLAWVATO_HOME/.claude.json" ]; then
  if [ -f /data/claude-config/.claude.json ]; then
    cp /data/claude-config/.claude.json "$CLAWVATO_HOME/.claude.json"
  else
    echo '{"hasCompletedOnboarding":true}' > "$CLAWVATO_HOME/.claude.json"
  fi
fi
chown clawvato:clawvato "$CLAWVATO_HOME/.claude.json" 2>/dev/null || true

# ── gws (Google Workspace CLI) auth ──
GWS_PERSIST_DIR="/data/gws-config"
if [ -n "$GWS_CONFIG_B64" ]; then
  mkdir -p "$GWS_PERSIST_DIR"
  echo "$GWS_CONFIG_B64" | base64 -d | tar xzf - -C "$GWS_PERSIST_DIR"
  mkdir -p "$CLAWVATO_HOME/.config/gws"
  cp -r "$GWS_PERSIST_DIR"/. "$CLAWVATO_HOME/.config/gws/"
  chown -R clawvato:clawvato "$CLAWVATO_HOME/.config" 2>/dev/null || true
  echo "[entrypoint] gws config restored from GWS_CONFIG_B64"
elif [ -d "$GWS_PERSIST_DIR" ] && [ -f "$GWS_PERSIST_DIR/credentials" ]; then
  mkdir -p "$CLAWVATO_HOME/.config/gws"
  cp -r "$GWS_PERSIST_DIR"/. "$CLAWVATO_HOME/.config/gws/"
  chown -R clawvato:clawvato "$CLAWVATO_HOME/.config" 2>/dev/null || true
  echo "[entrypoint] gws config restored from persistent volume"
else
  echo "[entrypoint] WARNING: No gws auth configured"
fi

# ── Start the agent as non-root user ──
# CC-native needs non-root for --dangerously-skip-permissions
# Hybrid engine also works fine as non-root
if [ "${ENGINE:-hybrid}" = "cc-native" ]; then
  echo "[entrypoint] Starting CC-Native Engine (as clawvato user)"
  exec su -s /bin/bash clawvato -c "/app/scripts/cc-native-entrypoint.sh"
else
  echo "[entrypoint] Starting Hybrid Engine (as clawvato user)"
  exec su -s /bin/bash clawvato -c "node dist/cli/index.js start"
fi
