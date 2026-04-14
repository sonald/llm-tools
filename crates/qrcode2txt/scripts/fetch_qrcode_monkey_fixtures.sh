#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIXTURES_DIR="${CRATE_DIR}/tests/fixtures"
API_URL="${QRCODE_MONKEY_API_URL:-https://api.qrcode-monkey.com/qr/custom}"

mkdir -p "${FIXTURES_DIR}"

curl_json() {
  local output_path="$1"
  local payload="$2"

  local -a curl_args=(
    --silent
    --show-error
    --fail
    -X POST
    "${API_URL}"
    -H
    "Content-Type: application/json"
  )

  if [[ -n "${QRCODE_MONKEY_RAPIDAPI_KEY:-}" ]]; then
    curl_args+=(-H "X-RapidAPI-Key: ${QRCODE_MONKEY_RAPIDAPI_KEY}")
  fi

  if [[ -n "${QRCODE_MONKEY_RAPIDAPI_HOST:-}" ]]; then
    curl_args+=(-H "X-RapidAPI-Host: ${QRCODE_MONKEY_RAPIDAPI_HOST}")
  fi

  curl "${curl_args[@]}" --data "${payload}" -o "${output_path}"
}

echo "Refreshing QRCode Monkey fixtures in ${FIXTURES_DIR}"

curl_json \
  "${FIXTURES_DIR}/qrcode-monkey-url.png" \
  '{"data":"https://example.com/qrcode2txt-live?case=url&ts=2026-04-14","size":500,"file":"png","download":false}'

curl_json \
  "${FIXTURES_DIR}/qrcode-monkey-text.png" \
  '{"data":"qrcode2txt live test\nline two: \u4F60\u597D QR","size":500,"file":"png","download":false}'

echo "Verifying refreshed fixtures with qrcode2txt"
(
  cd "${CRATE_DIR}"
  cargo run --quiet -- --format raw "${FIXTURES_DIR}/qrcode-monkey-url.png"
  cargo run --quiet -- --format raw "${FIXTURES_DIR}/qrcode-monkey-text.png"
)

echo "Done."
