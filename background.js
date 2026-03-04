// Service worker — manages extension state across tabs

importScripts("db.js");

const DEFAULT_STATE = { enabled: true };

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.storage.local.set(DEFAULT_STATE);

  // On a fresh install, seed IDB from data/private_seed.json if it exists.
  // On update or browser-restart activation, skip seeding.
  if (details.reason === "install") {
    await seedFromFile();
  }
});

// ---------------------------------------------------------------------------
// Seed IDB from data/private_seed.json
//
// The file is gitignored — it lives only on the developer's machine.
// Export it from the popup's "Export" button, save to data/private_seed.json.
// Future: data/public_seed.json (committed) will be seeded first, then
// private_seed.json will be applied on top.
// ---------------------------------------------------------------------------

async function seedFromFile() {
  const url = chrome.runtime.getURL("data/private_seed.json");
  let entries;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return; // file not present — cold start, that's fine
    entries = await resp.json();
  } catch {
    return; // malformed JSON or fetch error — skip silently
  }

  if (!Array.isArray(entries) || entries.length === 0) return;

  const db = await openDb();
  const tx = db.transaction("feedback", "readwrite");
  const store = tx.objectStore("feedback");
  const index = store.index("videoId");

  let imported = 0;
  for (const entry of entries) {
    if (!entry.videoId || !entry.userLabel) continue;
    // Skip if this videoId is already labeled (avoid duplicates)
    const existing = await promisifyRequest(index.getKey(IDBKeyRange.only(entry.videoId)));
    if (existing != null) continue;
    const { id: _drop, ...clean } = entry; // strip any stored id — IDB assigns a new one
    store.add(clean);
    imported++;
  }

  await new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = (e) => rej(e.target.error);
  });

  if (imported > 0) {
    console.log(`[AICD] Seeded ${imported} entries from private_seed.json`);
  }
}

// ---------------------------------------------------------------------------
// Offscreen document management
// ---------------------------------------------------------------------------

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
    justification: "Canvas access for thumbnail feature extraction",
  });
  console.log("[AICD] Offscreen document created");
}

// Maps videoId → tabId of the content script that requested the analysis.
const _pendingTabs = new Map();

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SET_ENABLED") {
    chrome.storage.local.set({ enabled: message.enabled });
    chrome.tabs.query({ url: "https://www.youtube.com/*" }, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      });
    });
    return false;
  }

  if (message.type === "GET_STATE") {
    chrome.storage.local.get(DEFAULT_STATE, sendResponse);
    return true;
  }

  if (message.type === "STORE_FEEDBACK") {
    const { entry } = message;
    if (entry?.videoId && entry?.userLabel) {
      openDb()
        .then((db) => storeFeedback(db, entry))
        .catch(() => {});
    }
    return false;
  }

  if (message.type === "GET_FEEDBACK_COUNTS") {
    openDb()
      .then((db) => getFeedbackCount(db))
      .then(sendResponse)
      .catch(() => sendResponse({ ai: 0, real: 0 }));
    return true; // keep channel open for async response
  }

  if (message.type === "EXPORT_FEEDBACK") {
    openDb()
      .then((db) => getAllFeedback(db))
      .then((entries) => {
        // Strip auto-generated IDs — seed files use videoId as natural key
        const clean = entries.map(({ id: _drop, ...rest }) => rest);
        sendResponse({ entries: clean });
      })
      .catch(() => sendResponse({ entries: [] }));
    return true;
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
