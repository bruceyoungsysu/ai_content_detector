// Service worker — manages extension state across tabs

const DEFAULT_STATE = { enabled: true };

// Initialize state on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set(DEFAULT_STATE);
});

// ---------------------------------------------------------------------------
// Offscreen document management
// TF.js must run in an offscreen document — service workers have no WebGL/DOM.
// ---------------------------------------------------------------------------

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
    justification: "Run TF.js MobileNet inference on Canvas for thumbnail classification",
  });
  console.log("[AICD L2] Offscreen document created");
}

// Maps videoId → tabId of the content script that requested the analysis.
// Single-tab resolution per videoId (MVP limitation — last tab wins).
const _pendingTabs = new Map();

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SET_ENABLED") {
    chrome.storage.local.set({ enabled: message.enabled });

    // Notify all YouTube tabs
    chrome.tabs.query({ url: "https://www.youtube.com/*" }, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      });
    });
    return false;
  }

  if (message.type === "GET_STATE") {
    chrome.storage.local.get(DEFAULT_STATE, sendResponse);
    return true; // keep channel open for async response
  }

  if (message.type === "L2_ANALYZE_THUMBNAIL") {
    const { videoId } = message;
    const tabId = sender.tab?.id;
    if (!tabId || !videoId) return false;

    console.log(`[AICD L2] → analyze ${videoId} (tab ${tabId})`);
    _pendingTabs.set(videoId, tabId);
    const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_ANALYZE",
        videoId,
        thumbnailUrl,
      }).catch((err) => console.warn("[AICD L2] Failed to reach offscreen:", err));
    });
    return false;
  }

  if (message.type === "OFFSCREEN_RESULT") {
    const { videoId, score, error } = message;
    const tabId = _pendingTabs.get(videoId);
    _pendingTabs.delete(videoId);

    if (!tabId) return false;

    if (error) {
      console.warn(`[AICD L2] ✗ ${videoId}:`, error);
      return false;
    }

    console.log(`[AICD L2] ✓ ${videoId} score=${score?.toFixed(3)}`);
    chrome.tabs.sendMessage(tabId, { type: "L2_RESULT", videoId, score })
      .catch(() => {});
    return false;
  }
});
