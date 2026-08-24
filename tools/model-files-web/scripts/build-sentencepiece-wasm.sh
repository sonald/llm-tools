#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SENTENCEPIECE_SOURCE=${SENTENCEPIECE_SOURCE:-/tmp/model-files-sentencepiece-v0.2.2}
ABSEIL_SOURCE=${ABSEIL_SOURCE:-/tmp/model-files-abseil-20260526.0}
EMSDK_ROOT=${EMSDK_ROOT:-/tmp/model-files-emsdk-6.0.5}
EXPECTED_COMMIT=e0cce7d37b065b5140349dbe12c6bcf6192fdd78
EXPECTED_ABSEIL_COMMIT=5650e9cf76d3be4318d5fa3af38ee483ddfd5e4a
EXPECTED_EMSDK_COMMIT=e5bd3d0874e302a18f13c5b41f5bacf9a40c8e59
EXPECTED_EMSCRIPTEN_VERSION=6.0.5
EXPECTED_EMSCRIPTEN_COMMIT=1db513782be24469589d7cb8a1f1834e9a33f271
BUILD_ROOT=${BUILD_ROOT:-$(mktemp -d /tmp/model-files-sentencepiece-wasm.XXXXXX)}
OUTPUT_DIR="$PROJECT_ROOT/src/vendor/sentencepiece"

[ "$(git -C "$SENTENCEPIECE_SOURCE" rev-parse HEAD)" = "$EXPECTED_COMMIT" ] || {
  echo "SentencePiece source HEAD mismatch" >&2
  exit 1
}

[ "$(git -C "$ABSEIL_SOURCE" rev-parse HEAD)" = "$EXPECTED_ABSEIL_COMMIT" ] || {
  echo "Abseil source HEAD mismatch" >&2
  exit 1
}

[ "$(git -C "$EMSDK_ROOT" rev-parse HEAD)" = "$EXPECTED_EMSDK_COMMIT" ] || {
  echo "Emsdk source HEAD mismatch" >&2
  exit 1
}

"$EMSDK_ROOT/upstream/emscripten/emcc" --version | head -n 1 \
  | grep -qF -- ") $EXPECTED_EMSCRIPTEN_VERSION ($EXPECTED_EMSCRIPTEN_COMMIT)" || {
  echo "emcc version must be $EXPECTED_EMSCRIPTEN_VERSION ($EXPECTED_EMSCRIPTEN_COMMIT)" >&2
  exit 1
}

cmake -S "$PROJECT_ROOT/src/vendor/sentencepiece" -B "$BUILD_ROOT" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$EMSDK_ROOT/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
  -DSENTENCEPIECE_SOURCE="$SENTENCEPIECE_SOURCE" \
  -DABSEIL_SOURCE="$ABSEIL_SOURCE"
cmake --build "$BUILD_ROOT" --target sentencepiece-wasm

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR/sentencepiece-wasm.mjs" "$OUTPUT_DIR/sentencepiece-wasm.wasm"
cp "$BUILD_ROOT/sentencepiece-wasm.mjs" "$OUTPUT_DIR/sentencepiece-wasm.mjs"
cp "$BUILD_ROOT/sentencepiece-wasm.wasm" "$OUTPUT_DIR/sentencepiece-wasm.wasm"
chmod 0644 "$OUTPUT_DIR/sentencepiece-wasm.mjs" "$OUTPUT_DIR/sentencepiece-wasm.wasm"
