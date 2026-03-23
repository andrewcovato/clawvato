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

# Pre-approve workspace trust for /app so CC never shows the trust prompt.
# Trust is stored in .claude.json under the project path key with
# hasTrustDialogAccepted: true (discovered from local CC config).
# Use node to merge into existing .claude.json without clobbering it.
node -e "
  const fs = require('fs');
  const p = '$CLAWVATO_HOME/.claude.json';
  let data = {};
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  data['/app'] = data['/app'] || {};
  data['/app'].hasTrustDialogAccepted = true;
  data.hasCompletedOnboarding = true;
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  console.log('[entrypoint] Pre-approved workspace trust for /app');
"
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

# ── Pre-approve workspace trust for CC ──
# CC asks "Yes, I trust this folder" on first run. Pre-create the
# project trust file so the prompt never appears.
# Trust is stored per-project in ~/.claude/projects/ keyed by path hash.
CLAWVATO_CLAUDE_DIR="$CLAWVATO_HOME/.claude"
mkdir -p "$CLAWVATO_CLAUDE_DIR"

# Create a settings file that trusts /app
# Also set acceptedTos to skip any TOS prompts
cat > "$CLAWVATO_HOME/.claude.json" << 'TRUST_EOF'
{
  "hasCompletedOnboarding": true,
  "acceptedTos": true
}
TRUST_EOF

# Pre-create project trust for /app
APP_PROJECTS_DIR="$CLAWVATO_CLAUDE_DIR/projects"
mkdir -p "$APP_PROJECTS_DIR"
# CC uses the project path to create a hash-based directory.
# We create a global allowedDirectories setting instead.
cat > "$CLAWVATO_CLAUDE_DIR/settings.json" << 'SETTINGS_EOF'
{
  "permissions": {
    "allow": [],
    "deny": []
  }
}
SETTINGS_EOF

chown -R clawvato:clawvato "$CLAWVATO_HOME" 2>/dev/null || true

# ── Start the agent as non-root user ──
# CC-native needs non-root for --dangerously-skip-permissions
# Use su with --preserve-environment to pass all env vars
if [ "${ENGINE:-hybrid}" = "cc-native" ]; then
  echo "[entrypoint] Starting CC-Native Engine (as clawvato user)"
  exec su -p -s /bin/bash clawvato -c "/app/scripts/cc-native-entrypoint.sh"
else
  echo "[entrypoint] Starting Hybrid Engine (as clawvato user)"
  exec su -p -s /bin/bash clawvato -c "node dist/cli/index.js start"
fi
