#!/usr/bin/env python3
"""
export_model.py — Download Ayai1's EfficientNet-B0 AI-image-detector
checkpoint and export it to ONNX format for ONNX Runtime Web inference.

Usage:
    pip install torch torchvision onnx
    python3 export_model.py

Output: ai_detector/ai_detector.onnx  (~20 MB)

Class mapping (from the original training's ImageFolder alphabetical ordering):
    logits[0] = FAKE  (AI-generated image)
    logits[1] = REAL  (authentic photograph)

In offscreen.js, computeAiScore() returns softmax(logits)[0] = P(FAKE).
"""

import os
import sys
import urllib.request

import torch
import torch.nn as nn
import torchvision.models as models

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CHECKPOINT_URL = (
    "https://github.com/Ayai1/AI-Generated-Image-Detection-Using-EfficientNet-B0"
    "/raw/main/efficientnet_b0_best.pth"
)
CHECKPOINT_PATH = "efficientnet_b0_best.pth"
OUT_DIR = "ai_detector"
ONNX_PATH = os.path.join(OUT_DIR, "ai_detector.onnx")

# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

def build_model():
    """EfficientNet-B0 with a 2-class head (0=FAKE, 1=REAL)."""
    model = models.efficientnet_b0(weights=None)
    # Replace default 1000-class linear with binary classifier
    in_features = model.classifier[1].in_features   # 1280
    model.classifier[1] = nn.Linear(in_features, 2)
    return model

# ---------------------------------------------------------------------------
# Checkpoint download
# ---------------------------------------------------------------------------

def _show_progress(count, block_size, total_size):
    if total_size > 0:
        pct = min(count * block_size * 100 // total_size, 100)
        print(f"\r  Downloading… {pct}%", end="", flush=True)

def download_checkpoint():
    if os.path.exists(CHECKPOINT_PATH):
        size_mb = os.path.getsize(CHECKPOINT_PATH) / 1024 / 1024
        print(f"  Checkpoint already present: {CHECKPOINT_PATH} ({size_mb:.1f} MB)")
        return

    print(f"  Downloading checkpoint from GitHub…")
    try:
        urllib.request.urlretrieve(CHECKPOINT_URL, CHECKPOINT_PATH, _show_progress)
        print()  # newline after progress
        size_mb = os.path.getsize(CHECKPOINT_PATH) / 1024 / 1024
        print(f"  Saved {CHECKPOINT_PATH} ({size_mb:.1f} MB)")
    except Exception as e:
        print(f"\n  Download failed: {e}")
        print(
            "\n  The file may be stored in Git LFS. Download it manually:\n"
            "    git clone https://github.com/Ayai1/AI-Generated-Image-Detection-Using-EfficientNet-B0\n"
            "    cp 'AI-Generated-Image-Detection-Using-EfficientNet-B0/efficientnet_b0_best.pth' .\n"
        )
        sys.exit(1)

# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def export():
    os.makedirs(OUT_DIR, exist_ok=True)

    download_checkpoint()

    model = build_model()

    print("  Loading weights…")
    state = torch.load(CHECKPOINT_PATH, map_location="cpu", weights_only=False)

    # Handle common checkpoint wrapper formats
    if isinstance(state, dict):
        for key in ("model_state_dict", "state_dict", "model"):
            if key in state:
                state = state[key]
                break

    model.load_state_dict(state)
    model.eval()
    print("  Weights loaded successfully.")

    dummy = torch.randn(1, 3, 224, 224)

    # Verify the model produces 2-class output
    with torch.no_grad():
        out = model(dummy)
    assert out.shape == (1, 2), f"Unexpected output shape: {out.shape} (expected [1, 2])"
    print(f"  Output shape verified: {list(out.shape)}")

    print(f"  Exporting to {ONNX_PATH}…")
    torch.onnx.export(
        model,
        dummy,
        ONNX_PATH,
        input_names=["image"],
        output_names=["logits"],
        dynamic_axes={"image": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=12,
    )

    size_mb = os.path.getsize(ONNX_PATH) / 1024 / 1024
    print(f"  Exported: {ONNX_PATH} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    print("=== EfficientNet-B0 → ONNX Export ===")
    export()
    print("=== Done. Run setup_model.sh to update ORT runtime files if needed. ===")
