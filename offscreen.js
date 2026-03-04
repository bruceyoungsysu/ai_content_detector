// offscreen.js — Chrome offscreen document for thumbnail processing.
// Runs inside offscreen.html where Canvas is available but the page is
// never shown to the user.
//
// Phase 1 (current): Returns a neutral score (0) for all thumbnails.
//   L2 scoring is inactive until the local logistic regression classifier
//   is trained from user feedback (Phase 5-6).
//
// Phase 5+: This file will be extended with:
//   - extractFeatures()         hand-crafted 30-feature image vector
//   - OFFSCREEN_EXTRACT_BATCH   batch feature extraction for training
//   - predictLR()               apply trained weights from chrome.storage.local

console.log("[AICD] offscreen.js loaded (Phase 1 — neutral mode)");

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "OFFSCREEN_ANALYZE") return;

  const { videoId } = message;

  // Neutral score — no model loaded yet.
  // Phase 5-6 will replace this with canvas feature extraction + LR inference.
  chrome.runtime.sendMessage({ type: "OFFSCREEN_RESULT", videoId, score: 0 });
});
