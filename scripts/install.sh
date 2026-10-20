#!/usr/bin/env bash
# Install opencode2-local-memory into opencode's plugin list.
#
# opencode loads plugins declared in its config's "plugins" array. A plugin
# entry may be an npm spec or an absolute local path to a directory whose
# package.json "main" points at the plugin module. opencode runs .ts directly,
# so there is no build step.
#
# This script adds this project's absolute path to the "plugins" array of the
# opencode config, trying (in order):
#   1. $OPENCODE_CONFIG if set
#   2. ~/.config/opencode/opencode.jsonc
#   3. ~/.config/opencode/opencode.json
#
# After running it, restart opencode (or open a new session) for the plugin to
# load.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CONFIG=""
if [ -n "${OPENCODE_CONFIG:-}" ]; then
  CONFIG="$OPENCODE_CONFIG"
elif [ -f "$HOME/.config/opencode/opencode.jsonc" ]; then
  CONFIG="$HOME/.config/opencode/opencode.jsonc"
elif [ -f "$HOME/.config/opencode/opencode.json" ]; then
  CONFIG="$HOME/.config/opencode/opencode.json"
else
  CONFIG="$HOME/.config/opencode/opencode.json"
fi

echo "[opencode2-local-memory] project: $PROJECT_DIR"
echo "[opencode2-local-memory] config:  $CONFIG"

mkdir -p "$(dirname "$CONFIG")"
if [ ! -f "$CONFIG" ]; then
  printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": []\n}\n' > "$CONFIG"
  echo "[opencode2-local-memory] created $CONFIG"
fi

cp "$CONFIG" "$CONFIG.bak-opencode2-local-memory"

# jsonc/json edit via node (opencode ships node). Keeps // comments by only
# touching the plugins array through a tolerant parse.
node - "$CONFIG" "$PROJECT_DIR" <<'NODE'
const fs = require('node:fs')
const [, , configPath, projectDir] = process.argv
let raw = fs.readFileSync(configPath, 'utf-8')
// Strip // and /* */ comments for parsing only; we re-serialize as plain JSON.
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
let config
try {
  config = JSON.parse(stripped)
} catch (e) {
  console.error('[opencode2-local-memory] could not parse config as JSON: ' + e.message)
  console.error('Add "' + projectDir + '" to the "plugins" array manually.')
  process.exit(1)
}
if (!Array.isArray(config.plugins)) config.plugins = []
const already = config.plugins.some((p) =>
  p === projectDir || (Array.isArray(p) && p[0] === projectDir))
if (already) {
  console.log('[opencode2-local-memory] already in plugins list; nothing to do')
} else {
  config.plugins.push(projectDir)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  console.log('[opencode2-local-memory] added to plugins list')
  console.log('[opencode2-local-memory] note: JSON comments in the original config were dropped; a .bak was saved')
}
NODE

echo
echo "Install complete. Restart opencode (or open a new session) for the plugin to load."
