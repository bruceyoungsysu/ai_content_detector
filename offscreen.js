// offscreen.js — ONNX Runtime Web inference host for Layer 2 thumbnail classification.
// Runs inside offscreen.html (a Chrome offscreen document) where WASM and Canvas
// are available but the page is never displayed to the user.
//
// Model: EfficientNet-B0 fine-tuned on 120k AI vs. real images
//   (Ayai1/AI-Generated-Image-Detection-Using-EfficientNet-B0)
// Output: 2-class logits — index 0 = FAKE (AI-generated), index 1 = REAL

// ---------------------------------------------------------------------------
// ONNX Runtime configuration
// Point ORT at the WASM binaries bundled with the extension so it never
// tries to fetch them from the internet.
// ---------------------------------------------------------------------------

console.log("[AICD L2] offscreen.js loaded");

// ORT spawns an internal Worker to load WASM. Chrome-extension:// URLs are
// not fetchable inside Workers, so we fetch the binaries here in the main
// offscreen-page context and re-expose them as blob: URLs that Workers can use.
async function setupWasm() {
  const [baseBlob, simdBlob] = await Promise.all([
    fetch(chrome.runtime.getURL("ort-wasm.wasm")).then(r => r.blob()),
    fetch(chrome.runtime.getURL("ort-wasm-simd.wasm")).then(r => r.blob()),
  ]);
  ort.env.wasm.wasmPaths = {
    "ort-wasm.wasm":      URL.createObjectURL(baseBlob),
    "ort-wasm-simd.wasm": URL.createObjectURL(simdBlob),
  };
  ort.env.wasm.numThreads = 1; // SharedArrayBuffer is unavailable in offscreen docs
}

const _wasmReady = setupWasm();

// ---------------------------------------------------------------------------
// Model — lazy singleton, loaded once and kept in memory
// ---------------------------------------------------------------------------

let _sessionPromise = null;

function getSession() {
  if (!_sessionPromise) {
    const modelUrl = chrome.runtime.getURL("ai_detector/ai_detector.onnx");
    _sessionPromise = _wasmReady.then(() =>
      ort.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"],
      })
    ).then(session => {
      console.log("[AICD L2] EfficientNet-B0 session ready.",
        "inputs:", session.inputNames,
        "outputs:", session.outputNames);
      return session;
    });
  }
  return _sessionPromise;
}

// ---------------------------------------------------------------------------
// Preprocessing: thumbnail URL → ONNX Tensor [1, 3, 224, 224]
//
// EfficientNet-B0 expects:
//   - Channel-first layout: NCHW  [batch, channels, height, width]
//   - Per-channel ImageNet normalisation: (x/255 − mean) / std
//       mean = [0.485, 0.456, 0.406]
//       std  = [0.229, 0.224, 0.225]
// ---------------------------------------------------------------------------

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD  = [0.229, 0.224, 0.225];

async function preprocessImage(thumbnailUrl) {
  const resp = await fetch(thumbnailUrl, { mode: "cors" });
  if (!resp.ok) throw new Error(`Thumbnail fetch failed: ${resp.status}`);

  const blob   = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(224, 224);
  const ctx    = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, 224, 224);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, 224, 224); // RGBA Uint8ClampedArray, HWC

  // Convert HWC-RGBA → CHW-RGB with ImageNet normalisation
  const float32 = new Float32Array(3 * 224 * 224);
  for (let y = 0; y < 224; y++) {
    for (let x = 0; x < 224; x++) {
      const src = (y * 224 + x) * 4;              // RGBA source offset
      for (let c = 0; c < 3; c++) {
        const pixel = data[src + c] / 255.0;
        float32[c * 224 * 224 + y * 224 + x] =
          (pixel - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
      }
    }
  }

  return new ort.Tensor("float32", float32, [1, 3, 224, 224]);
}

// ---------------------------------------------------------------------------
// Score — binary classifier output
//
// EfficientNet-B0 outputs 2-class logits:
//   logits[0] = FAKE  (AI-generated image)
//   logits[1] = REAL  (authentic photograph)
//
// Apply softmax and return P(FAKE) as the AI score [0, 1].
// ---------------------------------------------------------------------------

function computeAiScore(logits) {
  // Numerically stable 2-class softmax
  const maxLogit = Math.max(logits[0], logits[1]);
  const expFake  = Math.exp(logits[0] - maxLogit);
  const expReal  = Math.exp(logits[1] - maxLogit);
  return expFake / (expFake + expReal); // P(FAKE)
}

// ---------------------------------------------------------------------------
// Message handler — background sends OFFSCREEN_ANALYZE, we reply with
// OFFSCREEN_RESULT back to the background service worker
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "OFFSCREEN_ANALYZE") return;

  const { videoId, thumbnailUrl } = message;

  (async () => {
    try {
      const session = await getSession();
      const tensor  = await preprocessImage(thumbnailUrl);
      const feeds   = { [session.inputNames[0]]: tensor };
      const results = await session.run(feeds);
      const logits  = Array.from(results[session.outputNames[0]].data);
      const score   = computeAiScore(logits);

      chrome.runtime.sendMessage({ type: "OFFSCREEN_RESULT", videoId, score, logits });
    } catch (err) {
      console.warn(`[AICD L2] Inference error for ${videoId}:`, err.message);
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_RESULT", videoId, score: null, error: err.message,
      });
    }
  })();
});
