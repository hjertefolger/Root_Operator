#!/usr/bin/env bash
# Build the AX helper binary. Run from this directory.
set -euo pipefail
cd "$(dirname "$0")"

swiftc -O main.swift \
    -framework ApplicationServices \
    -framework AppKit \
    -framework Foundation \
    -o ax-helper

echo "Built: $(pwd)/ax-helper"
