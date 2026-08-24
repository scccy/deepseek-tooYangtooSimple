#!/usr/bin/env bash
# Sync this package into the active DSH web profile so code edits here are
# immediately picked up after a DSH restart (profile loader reads the copied
# package). Uses `cp` rather than a symlink because Node ESM resolves the
# package's @deepseek-ai imports against the profile's node_modules.
set -euo pipefail

PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
TARGET="$PROFILE/node_modules/dsh-speckit-workflow"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -h "$TARGET" ]]; then
  rm "$TARGET"
fi
mkdir -p "$TARGET"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'scripts' \
  --exclude 'node_modules' \
  "$PROJECT/" "$TARGET/"

# Ensure the profile bundle actually lists this package (dependency + bundles
# entry). `rsync` only copies files; without this the loader never picks up the
# plugin after a restart.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ ! -x "$NODE_BIN" ] && [ -x /Volumes/soft/lan/nodejs/v24/bin/node ]; then
  NODE_BIN="/Volumes/soft/lan/nodejs/v24/bin/node"
fi
if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  "$NODE_BIN" - "$PROFILE/package.json" <<'NODEJS'
const fs = require('fs')
const file = process.argv[2]
const p = JSON.parse(fs.readFileSync(file, 'utf8'))
p.dependencies = p.dependencies || {}
p.dependencies['dsh-speckit-workflow'] = 'file:/Volumes/project/github/dsh/dsh-speckit-workflow'
p.dsh = p.dsh || {}
p.dsh.profile = p.dsh.profile || {}
if (!Array.isArray(p.dsh.profile.bundles)) p.dsh.profile.bundles = []
if (!p.dsh.profile.bundles.includes('dsh-speckit-workflow')) p.dsh.profile.bundles.push('dsh-speckit-workflow')
fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n')
console.log('[dsh-speckit-workflow] ensured profile wiring (dependency + bundles entry)')
NODEJS
else
  echo '[dsh-speckit-workflow] node not found; profile package.json wiring NOT updated' >&2
fi

echo "[dsh-speckit-workflow] synced $PROJECT -> $TARGET"
echo "Restart DSH for host-side changes; reload the web UI for client changes."