#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HELPER="${HELPER:-$ROOT_DIR/build/native/ax-helper}"
TITLE="${PRESENCE_DELETE_TEST_TITLE:-Bridge test — wow moment}"
OUT_DIR="${TMPDIR:-/tmp}/presence-notes-context-delete.$(date +%Y%m%d%H%M%S).$$"
mkdir -p "$OUT_DIR"

if [[ ! -x "$HELPER" ]]; then
  node scripts/build-native-helpers.js
fi

write_create_payload() {
  local path="$1"
  node - "$path" "$TITLE" <<'NODE'
const fs = require('fs');
const [path, title] = process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({
  cursor_tolerance: 1,
  steps: [
    { op: 'launch', bundle_id: 'com.apple.Notes', activate: true, timeout_ms: 20000 },
    { op: 'wait_window', bundle_id: 'com.apple.Notes', timeout_ms: 20000 },
    { op: 'press_named', bundle_id: 'com.apple.Notes', label: 'New Note', role: 'AXButton' },
    { op: 'sleep', duration_ms: 600 },
    { op: 'resolve', as: 'editor', bundle_id: 'com.apple.Notes', scope: 'window', role: 'AXTextArea' },
    { op: 'focus', target: 'editor', allow_unstable: true },
    { op: 'set_value', target: 'editor', text: `${title}\nDelete me via contextual menu.` },
    { op: 'verify_value', target: 'editor', text: `${title}\nDelete me via contextual menu.` }
  ]
}, null, 2));
NODE
}

write_delete_payload() {
  local path="$1"
  node - "$path" "$TITLE" <<'NODE'
const fs = require('fs');
const [path, title] = process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({
  cursor_tolerance: 1,
  steps: [
    { op: 'launch', bundle_id: 'com.apple.Notes', activate: true, timeout_ms: 20000 },
    { op: 'wait_window', bundle_id: 'com.apple.Notes', timeout_ms: 20000 },
    { op: 'resolve', as: 'note_title', bundle_id: 'com.apple.Notes', scope: 'app', label: title, role: 'AXStaticText', prefer_roles: ['AXStaticText'] },
    { op: 'perform_action', target: 'note_title', action: 'AXShowMenu', fallback_right_click: true },
    { op: 'sleep', duration_ms: 350 },
    { op: 'resolve', as: 'delete_item', scope: 'system', label: 'Delete', role: 'AXMenuItem', prefer_roles: ['AXMenuItem'] },
    { op: 'perform_action', target: 'delete_item', action: 'AXPress' },
    { op: 'sleep', duration_ms: 1000 },
    { op: 'resolve', as: 'confirm_delete', bundle_id: 'com.apple.Notes', scope: 'window', label: 'Delete', role: 'AXButton', optional: true },
    { op: 'perform_action', target: 'confirm_delete', action: 'AXPress', optional: true },
    { op: 'sleep', duration_ms: 300 },
    { op: 'resolve', as: 'confirm_ok', bundle_id: 'com.apple.Notes', scope: 'window', label: 'OK', role: 'AXButton', optional: true },
    { op: 'perform_action', target: 'confirm_ok', action: 'AXPress', optional: true },
    { op: 'sleep', duration_ms: 1000 }
  ]
}, null, 2));
NODE
}

write_verify_absent_payload() {
  local path="$1"
  node - "$path" "$TITLE" <<'NODE'
const fs = require('fs');
const [path, title] = process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({
  cursor_tolerance: 1,
  steps: [
    { op: 'launch', bundle_id: 'com.apple.Notes', activate: true, timeout_ms: 20000 },
    { op: 'wait_window', bundle_id: 'com.apple.Notes', timeout_ms: 20000 },
    { op: 'verify_absent', bundle_id: 'com.apple.Notes', scope: 'app', label: title, role: 'AXStaticText' }
  ]
}, null, 2));
NODE
}

run_act() {
  local name="$1"
  local payload="$2"
  local result="$OUT_DIR/$name.result.json"
  "$HELPER" act --file "$payload" > "$result"
  node - "$name" "$result" <<'NODE'
const fs = require('fs');
const [name, resultPath] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const steps = (result.steps || []).map((step) => ({
  i: step.index,
  op: step.op,
  ok: step.ok === true,
  error: step.error,
  role: step.role,
  label: step.label,
  action: step.action,
  performed: step.performed,
  fallback: step.fallback,
  cursor_delta: step.cursor_delta,
}));
console.log(`[${name}] ${result.ok ? 'ok' : 'failed'} cursor_delta=${Number(result.cursor_delta || 0).toFixed(2)}`);
console.log(JSON.stringify(steps, null, 2));
if (!result.ok) {
  console.error(`[${name}] full result: ${resultPath}`);
  process.exit(1);
}
NODE
}

cursor_before="$("$HELPER" cursor-position)"
printf '%s\n' "$cursor_before" > "$OUT_DIR/cursor.before.json"

create_payload="$OUT_DIR/create.json"
delete_payload="$OUT_DIR/delete-context-menu.json"
verify_payload="$OUT_DIR/verify-absent.json"
write_create_payload "$create_payload"
write_delete_payload "$delete_payload"
write_verify_absent_payload "$verify_payload"

run_act create "$create_payload"
run_act delete-context-menu "$delete_payload"
run_act verify-absent "$verify_payload"

cursor_after="$("$HELPER" cursor-position)"
printf '%s\n' "$cursor_after" > "$OUT_DIR/cursor.after.json"

node - "$OUT_DIR/cursor.before.json" "$OUT_DIR/cursor.after.json" <<'NODE'
const fs = require('fs');
const [beforePath, afterPath] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
const dx = Number(after.x) - Number(before.x);
const dy = Number(after.y) - Number(before.y);
const delta = Math.sqrt(dx * dx + dy * dy);
console.log(`[cursor] delta=${delta.toFixed(2)} before=(${before.x},${before.y}) after=(${after.x},${after.y})`);
if (delta > 0.01) {
  process.exit(1);
}
NODE

echo "[done] evidence: $OUT_DIR"
