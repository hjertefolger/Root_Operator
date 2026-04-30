#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'build', 'native');

if (process.platform !== 'darwin') {
    process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

function runCompiler(label, compiler, args, fallbackArgs) {
    let result = spawnSync('xcrun', [compiler, ...args], { stdio: 'inherit' });
    if (result.error && result.error.code === 'ENOENT') {
        result = spawnSync(compiler, fallbackArgs || args, { stdio: 'inherit' });
    }
    if (result.error) {
        console.error(`[build:native] ${label}: failed to spawn ${compiler}: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

// 1) cursor-pointer-tap (C, ApplicationServices) — existing helper.
{
    const source = path.join(root, 'src', 'main', 'native', 'cursor-pointer-tap.c');
    const output = path.join(outDir, 'cursor-pointer-tap');
    const args = [
        '-std=c11', '-Wall', '-Wextra', '-O2',
        source,
        '-framework', 'ApplicationServices',
        '-o', output,
    ];
    runCompiler('cursor-pointer-tap', 'clang', args);
    fs.chmodSync(output, 0o755);
    console.log(`[build:native] built ${path.relative(root, output)}`);
}

// 2) ax-helper (Swift, ApplicationServices + AppKit). Drives macOS
// accessibility reads/writes for the Presence agent. Built to
// build/native/ax-helper and shipped via electron-builder asarUnpack.
{
    const source = path.join(root, 'src', 'main', 'native', 'ax-helper', 'main.swift');
    const output = path.join(outDir, 'ax-helper');
    const args = [
        '-O', source,
        '-framework', 'ApplicationServices',
        '-framework', 'AppKit',
        '-framework', 'Foundation',
        '-o', output,
    ];
    runCompiler('ax-helper', 'swiftc', args);
    fs.chmodSync(output, 0o755);
    console.log(`[build:native] built ${path.relative(root, output)}`);
}
