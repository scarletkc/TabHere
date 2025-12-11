#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Please install Node.js/npm first." >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "zip not found. Please install zip first." >&2
  exit 1
fi

echo "Building extension..."
npm run build

VERSION="$(node --input-type=module - <<'NODE'
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
process.stdout.write(manifest.version || "0.0.0");
NODE
)"

OUT_DIR="$ROOT_DIR/release"
mkdir -p "$OUT_DIR"

ZIP_NAME="tabhere-${VERSION}.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t tabhere)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "Collecting files..."
cp manifest.json "$TMP_DIR/"
cp -r dist public _locales "$TMP_DIR/"
[[ -f LICENSE ]] && cp LICENSE "$TMP_DIR/"
[[ -f README.md ]] && cp README.md "$TMP_DIR/"

# Remove sourcemaps by default to shrink package.
if [[ "${KEEP_SOURCEMAP:-0}" != "1" ]]; then
  find "$TMP_DIR/dist" -name "*.map" -type f -delete || true
fi

rm -f "$ZIP_PATH"
(cd "$TMP_DIR" && zip -qr "$ZIP_PATH" .)

echo "Done: $ZIP_PATH"
echo "You can upload this zip to Chrome Web Store."
