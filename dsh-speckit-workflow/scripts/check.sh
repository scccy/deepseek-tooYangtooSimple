#!/usr/bin/env bash
# dsh-speckit-workflow v0.8 — fast local checks.
# Parse all lib modules, verify the vendored skills, and run the pure-machine
# smoke suite (SQLite ledger + orchestrator + stage graph + thread protocol).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${DSH_NODE:-}"
if [[ -z "$NODE" ]]; then
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" ]]; then
  for candidate in /Volumes/soft/lan/nodejs/v24/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
    if [[ -x "$candidate" ]]; then NODE="$candidate"; break; fi
  done
fi
if [[ -z "$NODE" ]]; then
  echo "error: node not found. Set DSH_NODE=/path/to/node or add node to PATH." >&2
  exit 1
fi

for file in lib/index.js lib/db.js lib/orchestrator.js lib/threads.js lib/worktree.js lib/stages.js lib/client.js; do
  "$NODE" --check "$ROOT/$file"
done
echo '[ok] all lib modules parse'

"$NODE" --input-type=module - "$ROOT" <<'NODE'
import { join } from 'node:path'
const root = process.argv[2]
const fs = await import('node:fs/promises')
const SKILLS = ['speckit-specify', 'speckit-worktrees-create', 'speckit-clarify', 'speckit-plan', 'speckit-checklist', 'speckit-tasks', 'speckit-analyze', 'speckit-taskstoissues', 'speckit-implement', 'speckit-converge']
for (const skill of SKILLS) {
  const text = await fs.readFile(join(root, 'skills', skill, 'SKILL.md'), 'utf8')
  if (text.trim().length === 0) throw new Error(`vendored skill ${skill} is empty`)
}
console.log('[ok] vendored skills present:', SKILLS.length)
const stages = await import(join(root, 'lib/stages.js'))
if (stages.STAGE_ORDER.length !== 9) throw new Error('stage graph must have 9 stages')
if (stages.COLUMNS.length !== 4) throw new Error('board must have 4 columns')
console.log('[ok] stage graph:', stages.STAGE_ORDER.join(' -> '))
NODE

"$NODE" --no-warnings "$ROOT/scripts/machine-smoke.mjs"

echo '[ok] dsh-speckit-workflow v0.8 checks passed'
