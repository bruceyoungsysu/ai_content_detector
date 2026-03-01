// Content script — orchestrates detection and badge rendering on YouTube.
// layer1.js is loaded before this file (see manifest.json).

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

function processCard(el) {
  if (!isEnabled) {
    el.removeAttribute("data-aicd");
    return;
  }

  const score = analyzeLayer1(el); // defined in layer1.js
  el.setAttribute("data-aicd", getBadgeState(score));
}

function applyFilter() {
  document
    .querySelectorAll(
      "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer"
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
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

chrome.runtime.sendMessage({ type: "GET_STATE" }, async (state) => {
  if (chrome.runtime.lastError) return;
  isEnabled = state?.enabled ?? true;
  await initLayer1(); // fetch ytInitialData via page bridge before first filter
  applyFilter();
  startObserving();
});
