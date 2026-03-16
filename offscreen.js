// offscreen.js — Chrome offscreen document for thumbnail processing.
// db.js and features.js are loaded before this file in offscreen.html.
//
// Phase 5 (current):
//   OFFSCREEN_ANALYZE      — fetch thumbnail → canvas → features → cache → score (0 until Phase 6)
//   OFFSCREEN_EXTRACT_BATCH — bulk feature extraction for training pipeline
//
// Phase 6 will add lr.js (loaded in offscreen.html) and predictLR() calls.

console.log("[AICD] offscreen.js loaded");

// Lazy singleton IDB connection
let _db = null;
async function getDb() {
  if (!_db) _db = await openDb(); // defined in db.js
  return _db;
}

// ---------------------------------------------------------------------------
// Feature extraction pipeline
// ---------------------------------------------------------------------------

/**
 * Fetch thumbnail, draw to CANVAS_SIZE×CANVAS_SIZE canvas, extract features.
 * Returns cached features if already computed for this videoId.
 * @returns {Promise<Float32Array>}
 */
async function extractFeatures(videoId, thumbnailUrl) {
  const db = await getDb();

  // Cache hit
  const cached = await getCachedFeatures(db, videoId);
  if (cached) return new Float32Array(cached);

  // Fetch & decode
  const resp = await fetch(thumbnailUrl, { mode: "cors" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching thumbnail`);
  const blob   = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  // Draw at canonical size
  const canvas = new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE); // defined in features.js
  const ctx    = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const features  = computeFeatureVector(imageData.data, CANVAS_SIZE, CANVAS_SIZE); // features.js

  // Cache for Phase 6 training pipeline
  await cacheFeatures(db, videoId, Array.from(features)); // db.js

  return features;
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/**
 * Run LR inference on a feature vector.
 * The model is passed in from background.js (offscreen documents don't have
 * access to chrome.storage — only chrome.runtime messaging APIs).
 */
function predict(features, lrModel) {
  if (typeof predictLR !== "function") return 0; // lr.js not loaded yet
  if (!lrModel) return 0; // cold-start: not enough labels yet
  return predictLR(features, lrModel); // defined in lr.js
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {

  // ── Single thumbnail analysis ──────────────────────────────────────────
  if (message.type === "OFFSCREEN_ANALYZE") {
    const { videoId, thumbnailUrl, tabId, lrModel } = message;

    extractFeatures(videoId, thumbnailUrl)
      .then(features => predict(features, lrModel))
      .then(score => {
        console.log(`[AICD L2] extracted features for ${videoId}, score=${score.toFixed(3)}`);
        chrome.runtime.sendMessage({ type: "OFFSCREEN_RESULT", videoId, score, tabId });
      })
      .catch(err => {
        console.warn(`[AICD L2] failed ${videoId}:`, err.message);
        chrome.runtime.sendMessage({ type: "OFFSCREEN_RESULT", videoId, score: 0, error: err.message, tabId });
      });

    return false;
  }

  // ── Batch extraction for training (Phase 6) ───────────────────────────
  if (message.type === "OFFSCREEN_EXTRACT_BATCH") {
    const items = message.items ?? []; // [{videoId, thumbnailUrl}, ...]
    const results = [];

    (async () => {
      for (const { videoId, thumbnailUrl } of items) {
        try {
          await extractFeatures(videoId, thumbnailUrl);
          results.push({ videoId, ok: true });
        } catch (err) {
          results.push({ videoId, ok: false, error: err.message });
        }
      }
      chrome.runtime.sendMessage({ type: "OFFSCREEN_EXTRACT_DONE", results });
    })();

    return false;
  }

});
