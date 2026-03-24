#!/bin/sh
set -e

# ── Fix volume permissions (runs as root, Railway mounts volume as root) ──
chown -R clawvato:clawvato /data 2>/dev/null || true

CLAWVATO_HOME="/home/clawvato"

# ── Claude CLI config persistence ──
mkdir -p /data/claude-config
rm -f "$CLAWVATO_HOME/.claude"
ln -sf /data/claude-config "$CLAWVATO_HOME/.claude"

# ── Pre-approve workspace trust for /app ──
# CC stores trust in ~/.claude.json under the project path key.
# Write it with the EXACT format CC uses locally (discovered from local config).
# Also write to /root/.claude.json in case CC checks there.
node -e "
  const fs = require('fs');
  const trustEntry = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: 1,
    hasClaudeMdExternalIncludesApproved: true
  };

  const paths = ['$CLAWVATO_HOME/.claude.json', '/root/.claude.json'];

  for (const p of paths) {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    data.hasCompletedOnboarding = true;
    data.numStartups = (data.numStartups || 0) + 1;
    // Trust /app (Railway workdir)
    data['/app'] = { ...trustEntry, ...(data['/app'] || {}), hasTrustDialogAccepted: true };
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    console.log('[entrypoint] Trust pre-approved in ' + p);
  }
"
chown clawvato:clawvato "$CLAWVATO_HOME/.claude.json" 2>/dev/null || true

# ── CC settings + hooks ──
mkdir -p "$CLAWVATO_HOME/.claude"
cat > "$CLAWVATO_HOME/.claude/settings.json" << 'SETTINGS_EOF'
{
  "permissions": {
    "allow": [],
    "deny": []
  },
  "skipDangerousModePermissionPrompt": true
}
SETTINGS_EOF
chown -R clawvato:clawvato "$CLAWVATO_HOME/.claude" 2>/dev/null || true

# ── gws (Google Workspace CLI) auth ──
GWS_PERSIST_DIR="/data/gws-config"
if [ -n "$GWS_CONFIG_B64" ]; then
  mkdir -p "$GWS_PERSIST_DIR"
  echo "$GWS_CONFIG_B64" | base64 -d | tar xzf - --no-same-owner --no-same-permissions -C "$GWS_PERSIST_DIR"
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

chown -R clawvato:clawvato "$CLAWVATO_HOME" 2>/dev/null || true

# ── Start the agent as non-root user ──
if [ "${ENGINE:-hybrid}" = "cc-native" ]; then
  echo "[entrypoint] Starting CC-Native Engine (as clawvato user)"
  exec su -p -s /bin/bash clawvato -c "/app/scripts/cc-native-entrypoint.sh"
else
  echo "[entrypoint] Starting Hybrid Engine (as clawvato user)"
  exec su -p -s /bin/bash clawvato -c "node dist/cli/index.js start"
fi
