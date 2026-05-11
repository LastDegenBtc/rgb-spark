#!/usr/bin/env bash
#
# Build the `rgb-spark-core` Rust crate to WASM and vendor the
# resulting JS+wasm+`.d.ts` artifacts into `frontend/src/lib/spark-core/`
# so they ship with the wallet bundle.
#
# This script is the single source of truth for the spark-core build —
# the frontend never invokes cargo / wasm-pack directly. Run it whenever
# the Rust side of `forks/rgb-spark-core/` changes, then
# `cd frontend && npm run dev` picks up the new artifacts.
#
# Setup (one time):
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-pack
#   sudo apt install clang             # needed by secp256k1-sys cross-compile
#
# Usage:
#   bash scripts/build-spark-core.sh           # release build (default)
#   PROFILE=dev bash scripts/build-spark-core.sh   # faster, larger wasm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE_DIR="$REPO_ROOT/forks/rgb-spark-core"
OUT_DIR="$REPO_ROOT/frontend/src/lib/spark-core"
PROFILE="${PROFILE:-release}"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "error: wasm-pack not on PATH. Install with: cargo install wasm-pack" >&2
  exit 1
fi

echo "==> Building rgb-spark-core ($PROFILE)"
cd "$CRATE_DIR"
case "$PROFILE" in
  release) wasm-pack build --target web --release ;;
  dev)     wasm-pack build --target web --dev ;;
  *) echo "error: PROFILE must be 'release' or 'dev'" >&2; exit 1 ;;
esac

echo "==> Vendoring artifacts → $OUT_DIR"
mkdir -p "$OUT_DIR"
# Only the files the frontend actually loads. We intentionally skip
# pkg/package.json (we don't publish as a separate npm package) and
# pkg/.gitignore (which would mask the vendored output from git).
cp "$CRATE_DIR/pkg/rgb_spark_core.js"           "$OUT_DIR/"
cp "$CRATE_DIR/pkg/rgb_spark_core.d.ts"         "$OUT_DIR/"
cp "$CRATE_DIR/pkg/rgb_spark_core_bg.wasm"      "$OUT_DIR/"
cp "$CRATE_DIR/pkg/rgb_spark_core_bg.wasm.d.ts" "$OUT_DIR/"

WASM_SIZE=$(du -h "$OUT_DIR/rgb_spark_core_bg.wasm" | cut -f1)
echo "==> Done. spark-core.wasm = $WASM_SIZE"
echo "    Import in TS:  import init, { deriveUTweaked } from '@/lib/spark-core/rgb_spark_core'"
