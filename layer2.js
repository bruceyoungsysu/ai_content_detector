// layer2.js — Content-script side of Layer 2 thumbnail classification.
// Manages request deduplication, concurrency capping, and result caching so
// that processCard() calls remain non-blocking while sharing a single
// in-flight request per videoId.
//
// Loaded before content.js (see manifest.json).

const MAX_CONCURRENT = 3;

// videoId → resolved score (number 0–1)
const _l2Cache = new Map();

// videoId → currently dispatched to background (awaiting OFFSCREEN_RESULT)
const _inFlight = new Set();

// videoId → array of resolve callbacks waiting for the result
const _waiters = new Map();

// videoIds queued but not yet dispatched (throttled by MAX_CONCURRENT)
const _queue = [];

// Number of requests currently in-flight
let _active = 0;

// videoIds whose in-flight request was started before the latest LR model
// update — their result should be discarded and the request re-queued so
// waiters get a score from the current model.
const _staleInFlight = new Set();

// ---------------------------------------------------------------------------
// Internal: drain the queue up to MAX_CONCURRENT slots
// ---------------------------------------------------------------------------

function _drainQueue() {
  while (_active < MAX_CONCURRENT && _queue.length > 0) {
    const videoId = _queue.shift();

    // May have been deduplicated while waiting in the queue
    if (_inFlight.has(videoId)) continue;

    _inFlight.add(videoId);
    _active++;
    console.log("[AICD L2] sending L2_ANALYZE_THUMBNAIL", videoId);
    chrome.runtime.sendMessage({ type: "L2_ANALYZE_THUMBNAIL", videoId })
      .catch(err => console.warn("[AICD L2] sendMessage failed:", err.message));
  }
}

// ---------------------------------------------------------------------------
// Result listener — background routes L2_RESULT to the originating tab
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  // New model trained — stale scores in cache are now wrong, clear them.
  // In-flight requests are left to complete; content.js will re-score after
  // applyFilter() is triggered by the same LR_MODEL_UPDATED broadcast.
  if (message.type === "LR_MODEL_UPDATED") {
    _l2Cache.clear();
    // Mark every currently in-flight request as stale — it was dispatched
    // before the new model was ready, so its score will be 0 (cold-start).
    // When the result arrives we re-queue instead of resolving waiters with 0.
    for (const videoId of _inFlight) _staleInFlight.add(videoId);
    return;
  }

  if (message.type !== "L2_RESULT") return;

  const { videoId, score } = message;

  _inFlight.delete(videoId);
  _active = Math.max(0, _active - 1);

  // Result arrived from a pre-model request — discard score and re-queue so
  // waiters receive a fresh prediction from the trained model.
  if (_staleInFlight.has(videoId)) {
    _staleInFlight.delete(videoId);
    _queue.push(videoId);
    _drainQueue();
    return;
  }

  if (score != null) _l2Cache.set(videoId, score);

  // Resolve all promises waiting on this videoId
  const waiters = _waiters.get(videoId) ?? [];
  _waiters.delete(videoId);
  for (const resolve of waiters) resolve(score ?? 0);

  _drainQueue();
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a Promise<number> (0–1) that resolves with the visual AI score for
 * the given videoId.  Multiple simultaneous calls for the same videoId share
 * a single in-flight request (piggyback pattern).
 */
function analyzeLayer2(videoId) {
  // Immediate cache hit
  if (_l2Cache.has(videoId)) return Promise.resolve(_l2Cache.get(videoId));

  return new Promise((resolve) => {
    // Register as a waiter so we receive the result when it arrives
    if (!_waiters.has(videoId)) _waiters.set(videoId, []);
    _waiters.get(videoId).push(resolve);

    // If already dispatched, just wait — the listener above will notify us
    if (_inFlight.has(videoId)) return;

    // Enqueue and attempt to dispatch
    _queue.push(videoId);
    _drainQueue();
  });
}
