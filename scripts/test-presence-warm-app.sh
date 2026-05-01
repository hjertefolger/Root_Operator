#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HELPER="${HELPER:-$ROOT/build/native/ax-helper}"
OUT_DIR="${OUT_DIR:-$(mktemp -d /tmp/presence-warm-app.XXXXXX)}"
WARM_VIDEO="${WARM_VIDEO:-/tmp/codex-warm-app-test.mov}"
IDLE_VIDEO="${IDLE_VIDEO:-/tmp/codex-presence-idle.mov}"

fail() {
  echo "FAIL: $*" >&2
  echo "Evidence: $OUT_DIR" >&2
  exit 1
}

require_ok() {
  local file="$1"
  node - "$file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const o = JSON.parse(fs.readFileSync(file, 'utf8'));
if (o.ok !== true) {
  console.error(JSON.stringify(o, null, 2));
  process.exit(1);
}
NODE
}

require_cursor_invariant() {
  local file="$1"
  node - "$file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const o = JSON.parse(fs.readFileSync(file, 'utf8'));
if (o.cursor_unchanged !== true || Number(o.cursor_delta) > 1) {
  console.error(JSON.stringify({
    error: o.error,
    failed_step: o.failed_step,
    failed_op: o.failed_op,
    cursor_unchanged: o.cursor_unchanged,
    cursor_delta: o.cursor_delta,
  }, null, 2));
  process.exit(1);
}
NODE
}

if [[ ! -x "$HELPER" ]]; then
  fail "missing helper at $HELPER; run node scripts/build-native-helpers.js"
fi

echo "Writing evidence to: $OUT_DIR"

"$HELPER" check | tee "$OUT_DIR/00-check.json"
node - "$OUT_DIR/00-check.json" <<'NODE'
const fs = require('fs');
const o = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (o.trusted !== true) {
  console.error('AX helper is not trusted in this environment.');
  process.exit(1);
}
NODE

WARM_NOTES_JSON="$OUT_DIR/01-warm-notes-chain.json"
node - "$WARM_NOTES_JSON" <<'NODE'
const fs = require('fs');
const out = process.argv[2];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const title = `Warm Notes ${stamp}`;
const body = 'Warm-app bridge path wrote this paragraph, formatted it, and preserved cursor position.';
const full = `${title}\n${body}`;
fs.writeFileSync(out, JSON.stringify({
  cursor_tolerance: 1,
  steps: [
    { op: 'launch_app', bundle: 'com.apple.Notes', activate: true, timeout_ms: 20000 },
    { op: 'wait_for_app_window', app: 'Notes', timeout_ms: 20000 },
    { op: 'press_named', app: 'Notes', label: 'New Note', role: 'AXButton' },
    { op: 'sleep', duration_ms: 700 },
    {
      op: 'resolve',
      var: 'editor',
      app: 'Notes',
      scope: 'app',
      role: 'AXTextArea',
      prefer_roles: ['AXTextArea', 'AXScrollArea'],
      skip_roles: ['AXOutline', 'AXTable', 'AXList']
    },
    { op: 'focus', target: 'editor' },
    { op: 'set_value', target: 'editor', text: full },
    { op: 'select_range', target: 'editor', location: 0, length: title.length },
    { op: 'menu', app: 'Notes', path: ['Format', 'Title'], activate: true },
    { op: 'select_range', target: 'editor', location: title.length + 1, length: body.length },
    { op: 'menu', app: 'Notes', path: ['Format', 'Body'], activate: true },
    { op: 'verify_value', target: 'editor', equals: full },
    { op: 'read', target: 'editor' }
  ],
  expected: { title, body, full }
}, null, 2));
NODE

"$HELPER" run-chain --file "$WARM_NOTES_JSON" | tee "$OUT_DIR/01-warm-notes-result.json"
require_ok "$OUT_DIR/01-warm-notes-result.json"
require_cursor_invariant "$OUT_DIR/01-warm-notes-result.json"

SAFARI_JSON="$OUT_DIR/02-safari-nav-chain.json"
node - "$SAFARI_JSON" <<'NODE'
const fs = require('fs');
const out = process.argv[2];
const url = 'https://en.wikipedia.org/wiki/Accessibility';
fs.writeFileSync(out, JSON.stringify({
  cursor_tolerance: 1,
  steps: [
    { op: 'launch_app', bundle: 'com.apple.Safari', activate: true, timeout_ms: 20000 },
    { op: 'wait_for_app_window', app: 'Safari', timeout_ms: 20000 },
    {
      op: 'resolve',
      var: 'address',
      app: 'Safari',
      scope: 'app',
      role: 'AXTextField',
      label: 'Search',
      prefer_roles: ['AXTextField', 'AXComboBox']
    },
    { op: 'focus', target: 'address' },
    { op: 'set_attribute', target: 'address', attribute: 'AXValue', value: url },
    { op: 'perform_action', target: 'address', action: 'AXConfirm' },
    { op: 'sleep', duration_ms: 2500 }
  ],
  expected: { url }
}, null, 2));
NODE

"$HELPER" run-chain --file "$SAFARI_JSON" | tee "$OUT_DIR/02-safari-nav-result.json"
require_ok "$OUT_DIR/02-safari-nav-result.json"
require_cursor_invariant "$OUT_DIR/02-safari-nav-result.json"

NOTES_READ_JSON="$OUT_DIR/03-notes-read-chain.json"
node - "$NOTES_READ_JSON" <<'NODE'
const fs = require('fs');
const out = process.argv[2];
fs.writeFileSync(out, JSON.stringify({
  cursor_tolerance: 1,
  steps: [
    { op: 'launch_app', bundle: 'com.apple.Notes', activate: true, timeout_ms: 20000 },
    {
      op: 'resolve',
      var: 'editor',
      app: 'Notes',
      scope: 'app',
      role: 'AXTextArea',
      prefer_roles: ['AXTextArea', 'AXScrollArea'],
      skip_roles: ['AXOutline', 'AXTable', 'AXList']
    },
    { op: 'read', target: 'editor' }
  ]
}, null, 2));
NODE
"$HELPER" run-chain --file "$NOTES_READ_JSON" | tee "$OUT_DIR/03-notes-read-result.json"
require_ok "$OUT_DIR/03-notes-read-result.json"
require_cursor_invariant "$OUT_DIR/03-notes-read-result.json"

APPEND_JSON="$OUT_DIR/04-notes-append-chain.json"
node - "$OUT_DIR/03-notes-read-result.json" "$APPEND_JSON" <<'NODE'
const fs = require('fs');
const readResult = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3];
const readStep = readResult.steps.find((step) => step.op === 'read');
const current = typeof readStep.value === 'string' ? readStep.value : '';
const append = `\nSafari warm flow append ${new Date().toISOString()}.`;
fs.writeFileSync(out, JSON.stringify({
  cursor_tolerance: 1,
  steps: [
    { op: 'launch_app', bundle: 'com.apple.Notes', activate: true, timeout_ms: 20000 },
    {
      op: 'resolve',
      var: 'editor',
      app: 'Notes',
      scope: 'app',
      role: 'AXTextArea',
      prefer_roles: ['AXTextArea', 'AXScrollArea'],
      skip_roles: ['AXOutline', 'AXTable', 'AXList']
    },
    { op: 'focus', target: 'editor' },
    { op: 'select_range', target: 'editor', location: current.length, length: 0 },
    { op: 'insert_text', target: 'editor', text: append },
    { op: 'verify_value', target: 'editor', contains: append.trim() },
    { op: 'read', target: 'editor' }
  ],
  expected: { append }
}, null, 2));
NODE
"$HELPER" run-chain --file "$APPEND_JSON" | tee "$OUT_DIR/04-notes-append-result.json"
require_ok "$OUT_DIR/04-notes-append-result.json"
require_cursor_invariant "$OUT_DIR/04-notes-append-result.json"

"$HELPER" run-chain '{"steps":[{"op":"launch_app","bundle":"com.apple.Notes","activate":true,"timeout_ms":20000},{"op":"wait_for_app_window","app":"Notes","timeout_ms":20000}]}' \
  | tee "$OUT_DIR/05-notes-window.json"
require_ok "$OUT_DIR/05-notes-window.json"
read -r SIDEBAR_X SIDEBAR_Y < <(node - "$OUT_DIR/05-notes-window.json" <<'NODE'
const fs = require('fs');
const o = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const wait = o.steps.find((step) => step.op === 'wait_for_app_window');
const frame = wait && wait.frame;
if (!frame) process.exit(1);
console.log(`${Math.round(frame.x + Math.min(180, frame.w * 0.22))} ${Math.round(frame.y + Math.min(220, frame.h * 0.32))}`);
NODE
)
"$HELPER" click-at "$SIDEBAR_X" "$SIDEBAR_Y" | tee "$OUT_DIR/06-sidebar-click.json"
require_ok "$OUT_DIR/06-sidebar-click.json"
"$HELPER" focus-element \
  --role AXTextArea \
  --prefer-role AXTextArea \
  --prefer-role AXScrollArea \
  --skip-role AXOutline \
  --skip-role AXTable \
  --skip-role AXList \
  | tee "$OUT_DIR/07-window-not-key-focus.json"
require_ok "$OUT_DIR/07-window-not-key-focus.json"

"$HELPER" cursor-position | tee "$OUT_DIR/08-click-stress-before.json"
node - "$OUT_DIR/08-click-stress-before.json" "$OUT_DIR/08-click-points.txt" <<'NODE'
const fs = require('fs');
const cursor = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const x = Number(cursor.x);
const y = Number(cursor.y);
const points = [
  [x + 18, y + 16],
  [x + 42, y + 18],
  [x + 58, y + 42],
  [x + 24, y + 56],
  [x + 12, y + 32],
].map(([px, py]) => `${Math.round(px)} ${Math.round(py)}`).join('\n');
fs.writeFileSync(process.argv[3], points + '\n');
NODE
i=0
while read -r x y; do
  i=$((i + 1))
  "$HELPER" click-at "$x" "$y" | tee "$OUT_DIR/08-click-stress-$i.json"
  require_ok "$OUT_DIR/08-click-stress-$i.json"
  node - "$OUT_DIR/08-click-stress-$i.json" <<'NODE'
const fs = require('fs');
const o = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (o.cursor_restored !== true || Number(o.cursor_delta) > 1) {
  console.error(JSON.stringify(o, null, 2));
  process.exit(1);
}
NODE
done < "$OUT_DIR/08-click-points.txt"

VISUAL_JSON="$OUT_DIR/09-visual-audit-chain.json"
node - "$VISUAL_JSON" <<'NODE'
const fs = require('fs');
const out = process.argv[2];
const first = `Visual audit first ${new Date().toISOString()}`;
const second = `${first}\nVisual audit second write.`;
fs.writeFileSync(out, JSON.stringify({
  cursor_tolerance: 1,
  steps: [
    { op: 'launch_app', bundle: 'com.apple.Notes', activate: true, timeout_ms: 20000 },
    { op: 'resolve', var: 'new_note', app: 'Notes', scope: 'app', role: 'AXButton', label: 'New Note' },
    { op: 'perform_action', target: 'new_note', action: 'AXPress' },
    { op: 'sleep', duration_ms: 700 },
    {
      op: 'resolve',
      var: 'editor',
      app: 'Notes',
      scope: 'app',
      role: 'AXTextArea',
      prefer_roles: ['AXTextArea', 'AXScrollArea'],
      skip_roles: ['AXOutline', 'AXTable', 'AXList']
    },
    { op: 'set_attribute', target: 'editor', attribute: 'AXValue', value: first },
    { op: 'hid', kind: 'click', target: 'editor' },
    { op: 'set_attribute', target: 'editor', attribute: 'AXValue', value: second },
    { op: 'perform_action', target: 'new_note', action: 'AXPress' }
  ]
}, null, 2));
NODE

rm -f "$WARM_VIDEO"
screencapture -V 15 "$WARM_VIDEO" &
CAPTURE_PID=$!
sleep 1
"$HELPER" run-chain --file "$VISUAL_JSON" | tee "$OUT_DIR/09-visual-audit-result.json"
wait "$CAPTURE_PID" || true
require_ok "$OUT_DIR/09-visual-audit-result.json"
require_cursor_invariant "$OUT_DIR/09-visual-audit-result.json"
[[ -s "$WARM_VIDEO" ]] || fail "missing visual audit recording at $WARM_VIDEO"

"$HELPER" focus-element \
  --role AXTextArea \
  --prefer-role AXTextArea \
  --prefer-role AXScrollArea \
  --skip-role AXOutline \
  --skip-role AXTable \
  --skip-role AXList \
  | tee "$OUT_DIR/10-idle-focus.json"
require_ok "$OUT_DIR/10-idle-focus.json"
rm -f "$IDLE_VIDEO"
screencapture -V 30 "$IDLE_VIDEO"
[[ -s "$IDLE_VIDEO" ]] || fail "missing idle recording at $IDLE_VIDEO"

echo "PASS: warm-app bridge scenarios completed."
echo "Evidence: $OUT_DIR"
echo "Visual audit recording: $WARM_VIDEO"
echo "Idle recording: $IDLE_VIDEO"
