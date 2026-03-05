// Content script — orchestrates detection and badge rendering on YouTube.
// layer1.js, layer2.js, feedback-ui.js, and layer3.js are loaded before this file.

let isEnabled = true;

// Score thresholds for badge states
const THRESHOLD_AI       = 0.6;
const THRESHOLD_POSSIBLE = 0.3;

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
  const s3 = analyzeLayer3(channelId);                // defined in layer3.js
  if (Math.abs(s3 - 0.5) >= 0.1) {
    el.setAttribute("data-aicd", getBadgeState(1 - (1 - s1) * (1 - s3)));
  }

  analyzeLayer2(videoId)                              // defined in layer2.js
    .then(s2 => {
      if (!isEnabled || !el.isConnected) return;
      const s3now = analyzeLayer3(channelId);         // re-read in case updated
      const combined = Math.abs(s3now - 0.5) < 0.1
        ? 1 - (1 - s1) * (1 - s2)                    // L3 neutral: L1 + L2 only
        : 1 - (1 - s1) * (1 - s2) * (1 - s3now);    // full three-way combination
      el.setAttribute("data-aicd", getBadgeState(combined));
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
  const data = await new Promise((r) => chrome.storage.local.get("channel_rep", r));
  const rep  = data.channel_rep ?? {};

  console.group("[AICD] Diagnostics");
  console.log("pageChannelId :", _pageChannelId ?? "(none — channel page header not found)");
  console.log("metaCache size:", _metaCache?.size ?? 0);
  console.log("channel_rep   :", Object.keys(rep).length, "channels");

  if (videoId) {
    const meta = _metaCache?.get(videoId);
    const cid  = meta?.channelId || _pageChannelId || "";
    const s3   = analyzeLayer3(cid);
    console.group(`Video: ${videoId}`);
    console.log("title    :", meta?.title      ?? "(not in cache)");
    console.log("channel  :", meta?.channel    ?? "(not in cache)");
    console.log("channelId:", cid              || "(empty — L3 will be neutral)");
    console.log("s3       :", s3.toFixed(3), Math.abs(s3 - 0.5) < 0.1 ? "→ neutral (< 0.1 from 0.5)" : "→ ACTIVE");
    console.log("rep entry:", rep[cid]         ?? "(none in storage)");
    console.groupEnd();
  } else {
    // Show all cached video entries (channelId column is most important)
    const rows = [...(_metaCache ?? [])].map(([vid, m]) => ({
      videoId: vid,
      channelId: m.channelId || "(empty)",
      channel: m.channel,
      title: m.title?.slice(0, 40),
    }));
    console.table(rows);
    console.table(rep);
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
