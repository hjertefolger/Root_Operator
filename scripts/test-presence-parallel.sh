#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HELPER="${HELPER:-$ROOT/build/native/ax-helper}"
OUT_DIR="${OUT_DIR:-$(mktemp -d /tmp/presence-parallel.XXXXXX)}"
CHAIN_JSON="$OUT_DIR/chain.json"
DISTRACTOR_LOG="/tmp/distractor.log"
DISTRACTOR_COMMAND="$OUT_DIR/distractor.command"
NOISE_PID=""

cleanup() {
  if [[ -n "${NOISE_PID:-}" ]]; then
    kill "$NOISE_PID" >/dev/null 2>&1 || true
  fi
  pkill -f "tail -f $DISTRACTOR_LOG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "Evidence: $OUT_DIR" >&2
  exit 1
}

if [[ ! -x "$HELPER" ]]; then
  fail "missing helper at $HELPER; run npm run build:native"
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

"$HELPER" run-chain '{"steps":[{"op":"launch_app","bundle":"com.apple.Notes","activate":true,"timeout_ms":20000},{"op":"wait_for_app_window","app":"Notes","timeout_ms":20000}]}' \
  > "$OUT_DIR/01-warm-notes.json"
node - "$OUT_DIR/01-warm-notes.json" <<'NODE'
const fs = require('fs');
const o = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (o.ok !== true) {
  console.error('Bridge launch/wait for Notes failed.');
  console.error(JSON.stringify(o, null, 2));
  process.exit(1);
}
NODE

: > "$DISTRACTOR_LOG"
(
  while true; do
    printf '%s distractor %s\n' "$(date +%H:%M:%S.%3N)" "$RANDOM" >> "$DISTRACTOR_LOG"
    sleep 0.15
  done
) &
NOISE_PID="$!"

cat > "$DISTRACTOR_COMMAND" <<EOF
#!/bin/zsh
tail -f "$DISTRACTOR_LOG"
EOF
chmod +x "$DISTRACTOR_COMMAND"
open -a Terminal "$DISTRACTOR_COMMAND"
sleep 0.8

"$HELPER" cursor-position | tee "$OUT_DIR/02-cursor-before.json"

node - "$CHAIN_JSON" <<'NODE'
const fs = require('fs');
const out = process.argv[2];
const title = 'Test parallel computer use';
const body = 'This body paragraph was written by Root Operator while a distractor Terminal window was streaming logs.';
const full = `${title}\n${body}`;

fs.writeFileSync(out, JSON.stringify({
  cursor_tolerance: 1,
  steps: [
    { op: 'launch_app', bundle_id: 'com.apple.Notes', activate: true, timeout_ms: 20000 },
    { op: 'wait_for_app_window', bundle_id: 'com.apple.Notes', timeout_ms: 20000 },
    { op: 'press_named', bundle_id: 'com.apple.Notes', label: 'New Note', role: 'AXButton' },
    { op: 'sleep', duration_ms: 600 },
    {
      op: 'resolve',
      as: 'editor',
      bundle_id: 'com.apple.Notes',
      role: 'AXTextArea',
      prefer_roles: ['AXTextArea', 'AXScrollArea'],
      skip_roles: ['AXOutline', 'AXTable', 'AXList']
    },
    { op: 'focus', target: 'editor', allow_unstable: true },
    { op: 'set_value', target: 'editor', text: title },
    { op: 'select_all', target: 'editor' },
    { op: 'menu', bundle_id: 'com.apple.Notes', path: ['Format', 'Title'], activate: true },
    { op: 'select_range', target: 'editor', location: title.length, length: 0 },
    { op: 'insert_text', target: 'editor', text: `\n${body}` },
    { op: 'select_range', target: 'editor', location: title.length + 1, length: body.length },
    { op: 'menu', bundle_id: 'com.apple.Notes', path: ['Format', 'Body'], activate: true },
    { op: 'verify_value', target: 'editor', equals: full },
    { op: 'read', target: 'editor' }
  ],
  expected: { title, body, full }
}, null, 2));
NODE

"$HELPER" run-chain --file "$CHAIN_JSON" > "$OUT_DIR/03-run-chain.json"
node - "$OUT_DIR/03-run-chain.json" <<'NODE'
const fs = require('fs');
const o = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(JSON.stringify({
  ok: o.ok,
  error: o.error,
  failed_step: o.failed_step,
  failed_op: o.failed_op,
  cursor_unchanged: o.cursor_unchanged,
  cursor_delta: o.cursor_delta,
  step_count: Array.isArray(o.steps) ? o.steps.length : 0,
}, null, 2));
NODE
"$HELPER" cursor-position | tee "$OUT_DIR/04-cursor-after.json"
"$HELPER" read-subtree \
  --role AXTextArea \
  --prefer-role AXTextArea \
  --prefer-role AXScrollArea \
  --skip-role AXOutline \
  --skip-role AXTable \
  --skip-role AXList \
  > "$OUT_DIR/05-post-read-subtree.json"

node - "$OUT_DIR" "$CHAIN_JSON" <<'NODE'
const fs = require('fs');
const outDir = process.argv[2];
const chainSpec = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const expected = chainSpec.expected;
const chain = JSON.parse(fs.readFileSync(`${outDir}/03-run-chain.json`, 'utf8'));
const before = JSON.parse(fs.readFileSync(`${outDir}/02-cursor-before.json`, 'utf8'));
const after = JSON.parse(fs.readFileSync(`${outDir}/04-cursor-after.json`, 'utf8'));
const post = JSON.parse(fs.readFileSync(`${outDir}/05-post-read-subtree.json`, 'utf8'));

function fail(message, payload) {
  console.error(message);
  if (payload !== undefined) console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

if (chain.ok !== true) fail('run-chain failed', chain);
if (chain.cursor_unchanged !== true) fail('run-chain reported cursor movement', chain);

const dx = Number(after.x) - Number(before.x);
const dy = Number(after.y) - Number(before.y);
const cursorDelta = Math.sqrt(dx * dx + dy * dy);
if (!Number.isFinite(cursorDelta) || cursorDelta > 1) {
  fail(`cursor moved after chain: delta=${cursorDelta}`, { before, after });
}

const steps = new Map((chain.steps || []).map((step) => [step.op + ':' + step.index, step]));
for (const [op, index] of [
  ['launch_app', 0],
  ['press_named', 2],
  ['set_value', 6],
  ['select_all', 7],
  ['menu', 8],
  ['insert_text', 10],
  ['menu', 12],
  ['verify_value', 13],
  ['read', 14],
]) {
  const step = steps.get(`${op}:${index}`);
  if (!step || step.ok !== true) fail(`missing or failed step ${index} ${op}`, step);
}

const titleMenu = chain.steps[8];
const bodyMenu = chain.steps[12];
if (titleMenu.leaf !== 'Title') fail('Format > Title did not run', titleMenu);
if (bodyMenu.leaf !== 'Body') fail('Format > Body did not run', bodyMenu);

const finalRead = chain.steps[14];
if (finalRead.value !== expected.full) {
  fail('final chain read did not match expected note text', {
    expected: expected.full,
    actual: finalRead.value,
  });
}

const postValue = post && post.tree && typeof post.tree.value === 'string' ? post.tree.value : '';
if (!postValue.includes(expected.title) || !postValue.includes(expected.body)) {
  fail('fresh post-chain AX read did not find the expected note text', post);
}

console.log('PASS: parallel Notes chain completed with cursor invariant.');
console.log(`Title: ${expected.title}`);
console.log(`Body: ${expected.body}`);
console.log(`Cursor delta: ${cursorDelta.toFixed(3)}`);
NODE
