#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const source = path.join(root, 'src', 'main', 'native', 'cursor-pointer-tap.c');
const outDir = path.join(root, 'build', 'native');
const output = path.join(outDir, 'cursor-pointer-tap');

if (process.platform !== 'darwin') {
    process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

const args = [
    'clang',
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-O2',
    source,
    '-framework',
    'ApplicationServices',
    '-o',
    output,
];

let result = spawnSync('xcrun', args, { stdio: 'inherit' });
if (result.error && result.error.code === 'ENOENT') {
    result = spawnSync('clang', args.slice(1), { stdio: 'inherit' });
}

if (result.error) {
    console.error(`[build:native] failed to spawn compiler: ${result.error.message}`);
    process.exit(1);
}

if (result.status !== 0) {
    process.exit(result.status || 1);
}

fs.chmodSync(output, 0o755);
console.log(`[build:native] built ${path.relative(root, output)}`);
