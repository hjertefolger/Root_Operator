#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="${1:-"$ROOT/build/native/ax-helper"}"

node - "$HELPER" <<'NODE'
const { spawnSync } = require('node:child_process');
const helper = process.argv[2];

function fail(message, payload) {
  console.error(`FAIL: ${message}`);
  if (payload !== undefined) {
    console.error(JSON.stringify(payload, null, 2));
  }
  process.exit(1);
}

function run(args) {
  const label = `ax-helper ${args.map((arg) => JSON.stringify(arg)).join(' ')}`;
  const res = spawnSync(helper, args, { encoding: 'utf8' });
  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();
  console.log(`$ ${label}`);
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  if (res.error) fail(`spawn failed: ${res.error.message}`);
  if (res.status !== 0) fail(`exit status ${res.status}`, { stdout, stderr });
  try {
    return JSON.parse(stdout);
  } catch (err) {
    fail(`bad JSON: ${err.message}`, { stdout, stderr });
  }
}

function assertOk(label, payload) {
  if (!payload || payload.error || payload.ok === false) {
    fail(`${label} failed`, payload);
  }
}

const check = run(['check']);
if (check.trusted !== true) {
  fail('Accessibility trust is not granted to this helper process', check);
}

const subtree = run(['read-subtree', '--role', 'AXTextArea', '--prefer-role', 'AXTextArea']);
assertOk('read-subtree AXTextArea', subtree);
const app = String(subtree.app || '');
const bundleID = String(subtree.bundle_id || '');
if (app !== 'Notes' && bundleID !== 'com.apple.Notes') {
  fail('frontmost app is not Notes; bring the target Notes window frontmost and rerun', { app, bundle_id: bundleID });
}

const focus = run(['focus-element', '--role', 'AXTextArea', '--prefer-role', 'AXTextArea']);
assertOk('focus-element AXTextArea', focus);
if (focus.fresh_verified !== true) {
  fail('focus-element did not report fresh process verification', focus);
}

const snapshot = run(['focused-snapshot']);
assertOk('focused-snapshot after focus-element', snapshot);

const focused = run(['read-focused']);
assertOk('read-focused after focus-element', focused);
if (focused.role !== 'AXTextArea') {
  fail('focused element is not AXTextArea', focused);
}

const selectAll = run(['select-all']);
assertOk('select-all', selectAll);

const body = run(['menu-command', 'Format', 'Body']);
assertOk('menu-command Format > Body', body);

const value = String(focused.value || subtree.tree?.value || '');
if (!value) {
  fail('focused Notes text area has no value to derive first-line length', focused);
}
const firstLineLength = value.split(/\r?\n/, 1)[0].length;
if (firstLineLength <= 0) {
  fail('first line length is zero', { firstLineLength, valuePrefix: value.slice(0, 80) });
}

const range = run(['select-range', '--location', '0', '--length', String(firstLineLength)]);
assertOk('select-range first line', range);

const title = run(['menu-command', 'Format', 'Title']);
assertOk('menu-command Format > Title', title);

console.log('PASS: Notes cold-start focus sequence completed.');
NODE
