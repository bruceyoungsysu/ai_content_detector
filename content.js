// Content script — orchestrates detection and badge rendering on YouTube.
// layer1.js, layer2.js, feedback-ui.js, and layer3.js are loaded before this file.

let isEnabled = true;

// Score thresholds for badge states
const THRESHOLD_AI       = 0.6;
const THRESHOLD_POSSIBLE = 0.3;

// ---------------------------------------------------------------------------
// L3-aware score combination
// ---------------------------------------------------------------------------

/**
 * Combine a base score (L1 alone, or L1+L2) with the L3 channel reputation.
 *
 * L3 is asymmetric around 0.5:
 *   s3 > 0.5  AI-leaning channel  → noisy-OR boost  (more AI evidence)
 *   s3 < 0.5  Real-leaning channel → linear dampen  (scale base toward 0)
 *   |s3-0.5| < 0.1  neutral          → no effect
 *
 * Dampening formula: base × (2 × s3)
 *   s3=0.5 → ×1.0 (no change)   s3=0.25 → ×0.5   s3=0 → ×0 (zeroed out)
 */
function combineWithL3(base, s3) {
  if (Math.abs(s3 - 0.5) < 0.1) return base;       // neutral dead zone
  if (s3 > 0.5) return 1 - (1 - base) * (1 - s3); // AI-leaning: boost
  return base * (2 * s3);                           // Real-leaning: dampen
}

// ---------------------------------------------------------------------------
// Per-layer score display
// ---------------------------------------------------------------------------

/**
 * Render (or update) the four-cell score strip at the bottom-left of a card.
 * Pass null for s2 while the async L2 result is still pending.
 * @param {Element} cardEl
 * @param {number}       s1        L1 metadata score
 * @param {number|null}  s2        L2 visual score (null = pending)
 * @param {number}       s3        L3 channel score
 * @param {number}       combined  final combined score
 */
function updateScoreDisplay(cardEl, s1, s2, s3, combined) {
  let wrap = cardEl.querySelector(".aicd-scores");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "aicd-scores";
    wrap.innerHTML =
      '<span class="aicd-s1"></span>' +
      '<span class="aicd-s2"></span>' +
      '<span class="aicd-s3"></span>' +
      '<span class="aicd-sc"></span>';
    cardEl.appendChild(wrap);
  }

  const fmt = v => v === null ? "…" : v.toFixed(2);

  wrap.querySelector(".aicd-s1").textContent = `metadata:${fmt(s1)}`;
  wrap.querySelector(".aicd-s2").textContent = `thumbnail:${fmt(s2)}`;
  wrap.querySelector(".aicd-s3").textContent = `channel:${fmt(s3)}`;

  const scEl = wrap.querySelector(".aicd-sc");
  scEl.textContent = `score:${fmt(combined)}`;
  scEl.className = "aicd-sc"; // reset
  if (combined >= THRESHOLD_AI)       scEl.classList.add("is-ai");
  else if (combined >= THRESHOLD_POSSIBLE) scEl.classList.add("is-possible");
  else                                     scEl.classList.add("is-safe");
}

// ---------------------------------------------------------------------------
// Badge state
// ---------------------------------------------------------------------------

function getBadgeState(score) {
  if (score >= THRESHOLD_AI)       return "ai";
  if (score >= THRESHOLD_POSSIBLE) return "possible";
  return "safe";
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

async function processCard(el) {
  if (!isEnabled) {
    el.removeAttribute("data-aicd");
    return;
  }

  const s1 = analyzeLayer1(el);                       // defined in layer1.js
  el.setAttribute("data-aicd", getBadgeState(s1));    // immediate L1 badge

  attachFeedbackWidget(el);                           // defined in feedback-ui.js

  const videoId   = getVideoId(el);                   // defined in layer1.js
  const channelId = getChannelId(el);                 // defined in layer1.js
  if (!videoId) return;

  // Apply L3 immediately (sync) — may already have channel signal.
  const s3      = analyzeLayer3(channelId);           // defined in layer3.js
  const earlyCombined = combineWithL3(s1, s3);
  el.setAttribute("data-aicd", getBadgeState(earlyCombined));
  updateScoreDisplay(el, s1, null, s3, earlyCombined); // L2 pending

  analyzeLayer2(videoId)                              // defined in layer2.js
    .then(s2 => {
      if (!isEnabled || !el.isConnected) return;
      const s3now    = analyzeLayer3(channelId);      // re-read in case updated
      const base     = 1 - (1 - s1) * (1 - s2);     // L1 + L2 Bayesian
      const combined = combineWithL3(base, s3now);
      el.setAttribute("data-aicd", getBadgeState(combined));
      updateScoreDisplay(el, s1, s2, s3now, combined);
    })
    .catch(() => {});                                  // L2 failures are non-fatal
  // No await — applyFilter() stays fast; layer2 resolves independently
}

function applyFilter() {
  document
    .querySelectorAll(
      "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, ytd-grid-video-renderer"
    )
    .forEach(processCard);
}

// ---------------------------------------------------------------------------
// Debounced MutationObserver
// Setting data-aicd is an *attributes* mutation — we only observe childList,
// so our own writes never re-trigger the observer.
// ---------------------------------------------------------------------------

let debounceTimer = null;

const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(applyFilter, 400);
});

function startObserving() {
  observer.observe(document.body, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// SPA navigation — YouTube fires yt-navigate-finish after each page change.
// Re-init the cache so the new page's ytInitialData is used.
// ---------------------------------------------------------------------------

window.addEventListener("yt-navigate-finish", async () => {
  invalidateMetaCache(); // defined in layer1.js
  await initLayer1();    // defined in layer1.js
  await initLayer3();    // defined in layer3.js (reload storage in case labels changed)
  applyFilter();
});

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SET_ENABLED") {
    isEnabled = message.enabled;
    applyFilter();
  }
  // layer3.js updates its cache; re-score so other cards from this channel
  // immediately reflect the new reputation.
  if (message.type === "CHANNEL_REP_UPDATED") {
    applyFilter();
  }
  // New LR model trained — layer2.js cleared its cache; re-score all cards
  // so thumbnails get fresh L2 scores from the updated model.
  if (message.type === "LR_MODEL_UPDATED") {
    applyFilter();
  }
});

// ---------------------------------------------------------------------------
// Debug API
// Trigger from the DevTools console (any context) with:
//   window.postMessage({ type: "AICD_DIAG" }, "*")
//   window.postMessage({ type: "AICD_DIAG", videoId: "VIDEO_ID" }, "*")
// Output appears in the same DevTools console.
// ---------------------------------------------------------------------------

window.addEventListener("message", async (e) => {
  if (e.source !== window || e.data?.type !== "AICD_DIAG") return;

  const { videoId } = e.data;

  // Print sync state first — no chrome API needed, works even after context loss.
  console.group("[AICD] Diagnostics");
  console.log("chrome.runtime:", chrome.runtime?.id ? "OK" : "INVALIDATED — reload the page!");
  console.log("pageChannelId :", _pageChannelId ?? "(none)");
  console.log("metaCache size:", _metaCache?.size ?? 0);

  // Show cache entries (no chrome API required).
  if (videoId) {
    const meta = _metaCache?.get(videoId);
    const cid  = meta?.channelId || _pageChannelId || "";
    console.log("channelId     :", cid || "(empty — L3 neutral)");
    console.log("channel       :", meta?.channel ?? "(not cached)");
    console.log("title         :", meta?.title   ?? "(not cached)");
    console.log("s3            :", analyzeLayer3(cid).toFixed(3));
  } else {
    const rows = [...(_metaCache ?? [])].map(([vid, m]) => ({
      videoId: vid, channelId: m.channelId || "(empty)", channel: m.channel,
    }));
    if (rows.length) console.table(rows);
  }

  // Async storage read — only if context is valid.
  if (chrome.runtime?.id) {
    try {
      const data = await new Promise((r) => chrome.storage.local.get("channel_rep", r));
      const rep  = data.channel_rep ?? {};
      console.log("channel_rep   :", Object.keys(rep).length, "channels stored");
      if (Object.keys(rep).length) console.table(rep);
    } catch (err) {
      console.warn("storage read failed:", err.message);
    }
  }

  console.groupEnd();
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

chrome.runtime.sendMessage({ type: "GET_STATE" }, async (state) => {
  if (chrome.runtime.lastError) return;
  isEnabled = state?.enabled ?? true;
  await initLayer1(); // fetch ytInitialData via page bridge before first filter
  await initLayer3(); // load channel reputation from storage
  applyFilter();
  startObserving();
});
