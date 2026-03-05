// layer3.js — Channel reputation scoring (L3).
//
// Maintains a per-channel Beta distribution score derived from user feedback.
// Score formula (Laplace smoothing):
//   score = (n_ai + 1) / (n_ai + n_real + 2)   → [0, 1], 0.5 when no data
//
// Storage: chrome.storage.local key "channel_rep"
//   { [channelId]: { n_ai, n_real, score, updatedAt } }
//
// Content.js should call initLayer3() before the first applyFilter(),
// then re-call it on SPA navigation.

let _repCache = {}; // channelId → { n_ai, n_real, score, updatedAt }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function initLayer3() {
  return new Promise((resolve) => {
    chrome.storage.local.get("channel_rep", (data) => {
      _repCache = data.channel_rep ?? {};
      resolve();
    });
  });
}

/**
 * Return the reputation score for a channel.
 * Returns 0.5 (neutral) when channelId is unknown.
 * Laplace smoothing naturally returns 0.5 at 0 labels, so no minimum-count
 * guard is needed — one label is enough to move the score.
 */
function analyzeLayer3(channelId) {
  if (!channelId) return 0.5;
  const rep = _repCache[channelId];
  if (!rep) return 0.5;
  return (rep.n_ai + 1) / (rep.n_ai + rep.n_real + 2);
}

// ---------------------------------------------------------------------------
// Live cache sync
// ---------------------------------------------------------------------------

// Background broadcasts CHANNEL_REP_UPDATED after every STORE_FEEDBACK write.
// Update the in-memory cache so subsequent analyzeLayer3() calls are current
// without needing a storage round-trip.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CHANNEL_REP_UPDATED") {
    _repCache[message.channelId] = message.entry;
  }
});
