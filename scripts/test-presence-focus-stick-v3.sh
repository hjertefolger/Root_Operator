#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

HELPER="${HELPER:-build/native/ax-helper}"
OUT_DIR="${OUT_DIR:-$(mktemp -d /tmp/presence-focus-stick-v3.XXXXXX)}"

if [[ ! -x "$HELPER" ]]; then
  echo "Missing helper: $HELPER" >&2
  echo "Run: npm run build:native" >&2
  exit 1
fi

echo "Writing evidence to: $OUT_DIR"

"$HELPER" check | tee "$OUT_DIR/00-check.json"
node -e '
const fs = require("fs");
const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (o.trusted !== true) {
  console.error("AX helper is not trusted in this environment.");
  process.exit(1);
}
' "$OUT_DIR/00-check.json"

osascript -e 'tell application "Notes" to activate'
sleep 0.8

"$HELPER" diagnostics | tee "$OUT_DIR/01-before-diagnostics.json" >/dev/null

"$HELPER" read-subtree \
  --role AXTextArea \
  --prefer-role AXTextArea \
  --prefer-role AXScrollArea \
  --skip-role AXOutline \
  --skip-role AXTable \
  --skip-role AXList \
  | tee "$OUT_DIR/02-read-subtree.json"

node -e '
const fs = require("fs");
const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (o.error || !o.tree || o.tree.role !== "AXTextArea") {
  console.error("Did not resolve the Notes editor AXTextArea.");
  console.error(JSON.stringify(o, null, 2));
  process.exit(1);
}
' "$OUT_DIR/02-read-subtree.json"

"$HELPER" focus-element \
  --role AXTextArea \
  --prefer-role AXTextArea \
  --prefer-role AXScrollArea \
  | tee "$OUT_DIR/03-focus-element.json"

node -e '
const fs = require("fs");
const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (o.ok !== true) {
  console.error("Focus did not stick.");
  console.error(JSON.stringify({
    error: o.error,
    detail: o.detail,
    focus_statuses: o.focus_statuses,
    focused_role: o.focused_role,
    focused_app: o.focused_app,
    target_window: o.target_window,
    diagnostics: o.diagnostics
  }, null, 2));
  process.exit(1);
}
if (o.role !== "AXTextArea") {
  console.error("Focused element was not the Notes AXTextArea.");
  console.error(JSON.stringify(o, null, 2));
  process.exit(1);
}
' "$OUT_DIR/03-focus-element.json"

"$HELPER" read-focused | tee "$OUT_DIR/04-read-focused.json"
node -e '
const fs = require("fs");
const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (o.error || o.role !== "AXTextArea") {
  console.error("Focused read did not return the Notes AXTextArea.");
  console.error(JSON.stringify(o, null, 2));
  process.exit(1);
}
' "$OUT_DIR/04-read-focused.json"

"$HELPER" select-all | tee "$OUT_DIR/05-select-all.json"
node -e '
const fs = require("fs");
const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (o.ok !== true || o.role !== "AXTextArea") {
  console.error("AX select-all did not succeed on the Notes AXTextArea.");
  console.error(JSON.stringify(o, null, 2));
  process.exit(1);
}
' "$OUT_DIR/05-select-all.json"

"$HELPER" diagnostics | tee "$OUT_DIR/06-after-diagnostics.json" >/dev/null

echo "PASS: Notes AXTextArea focus stuck, read-focused returned it, and select-all succeeded."
