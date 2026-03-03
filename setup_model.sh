#!/usr/bin/env bash
# setup_model.sh — downloads ONNX Runtime Web and exports EfficientNet-B0
# AI image detector model to ONNX via export_model.py.
#
# Requirements: Python 3, pip
# Python deps installed automatically: torch torchvision onnx
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

ORT_VERSION="1.18.0"
ORT_BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"

echo "=== AICD Layer 2 — Model Setup ==="

# ── Step 1: ONNX Runtime Web ──────────────────────────────────────────────────
echo ""
echo "[1/2] Downloading ONNX Runtime Web ${ORT_VERSION}..."

curl -fsSL -o ort.min.js             "${ORT_BASE}/ort.min.js"
echo "      ort.min.js              $(du -sh ort.min.js | cut -f1)"

curl -fsSL -o ort-wasm.wasm          "${ORT_BASE}/ort-wasm.wasm"
echo "      ort-wasm.wasm           $(du -sh ort-wasm.wasm | cut -f1)"

curl -fsSL -o ort-wasm-simd.wasm     "${ORT_BASE}/ort-wasm-simd.wasm"
echo "      ort-wasm-simd.wasm      $(du -sh ort-wasm-simd.wasm | cut -f1)"

# ── Step 2: EfficientNet-B0 AI detector → ONNX ────────────────────────────────
echo ""
echo "[2/2] Installing Python deps and exporting EfficientNet-B0 to ONNX..."
echo "      (torch + torchvision + onnx — first run takes a few minutes)"

pip3 install -q torch torchvision onnx
python3 export_model.py

echo "      ai_detector.onnx        $(du -sh ai_detector/ai_detector.onnx | cut -f1)"

# ── Cleanup: remove leftover files from old MobileNet setup ──────────────────
for f in tf.min.js mobilenet/mobilenet_v2.onnx; do
  [ -f "$f" ] && rm "$f" && echo "" && echo "      (removed leftover $f)"
done
[ -d mobilenet ] && rmdir --ignore-fail-on-non-empty mobilenet 2>/dev/null || true

echo ""
echo "=== Done. Reload the extension in chrome://extensions. ==="
