#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/app/src/main/assets/www"
DST_DIR="$ROOT_DIR/pwa"

mkdir -p "$DST_DIR"
cp -a "$SRC_DIR/." "$DST_DIR/"
echo "Sinkronisasi selesai: $SRC_DIR -> $DST_DIR"
