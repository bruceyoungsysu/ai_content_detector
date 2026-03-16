// Service worker — manages extension state across tabs

importScripts("db.js");
importScripts("lr.js");

const DEFAULT_STATE = { enabled: true };

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.storage.local.set(DEFAULT_STATE);

  if (details.reason === "install") {
    await seedFromFile();
  }

  // Train (or confirm cold-start) on every install/update
  trainOnStartup().catch(console.error);
});

// Train on browser restart (service worker re-activation)
chrome.runtime.onStartup.addListener(() => {
  trainOnStartup().catch(console.error);
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

// Singleton promise — prevents concurrent createDocument() calls racing each other.
// Set synchronously so a second caller returning the same promise, not a second creation.
let _offscreenReady = null;

function ensureOffscreen() {
  if (_offscreenReady) return _offscreenReady;
  _offscreenReady = (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
      justification: "Canvas access for thumbnail feature extraction",
    });
    console.log("[AICD] Offscreen document created");
  })();
  // Reset on failure so the next caller can retry.
  _offscreenReady.catch(() => { _offscreenReady = null; });
  return _offscreenReady;
}

// ---------------------------------------------------------------------------
// Channel reputation — L3
// ---------------------------------------------------------------------------

async function updateChannelRep(channelId, userLabel) {
  if (!channelId) return;

  const data = await new Promise((resolve) =>
    chrome.storage.local.get("channel_rep", resolve)
  );
  const rep   = data.channel_rep ?? {};
  const entry = rep[channelId]   ?? { n_ai: 0, n_real: 0 };

  if (userLabel === "ai")   entry.n_ai   += 1;
  if (userLabel === "real") entry.n_real += 1;
  entry.score     = (entry.n_ai + 1) / (entry.n_ai + entry.n_real + 2);
  entry.updatedAt = Date.now();
  rep[channelId]  = entry;

  await new Promise((resolve) => chrome.storage.local.set({ channel_rep: rep }, resolve));

  // Push the update to all open YouTube tabs so their L3 cache stays current.
  chrome.tabs.query({ url: "https://www.youtube.com/*" }, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, {
        type: "CHANNEL_REP_UPDATED",
        channelId,
        entry,
      }).catch(() => {});
    });
  });
}

// ---------------------------------------------------------------------------
// Logistic regression training pipeline
// ---------------------------------------------------------------------------

const MIN_SAMPLES_PER_CLASS = 10;

/**
 * Read all feedback + cached features, train LR, save model to storage.
 * Called on install, browser startup, and after new labels are collected.
 * Labeled videos without cached features are skipped (they'll be picked up
 * on the next training run once the user browses to those videos).
 */
async function trainOnStartup() {
  const db       = await openDb();
  const feedback = await getAllFeedback(db);

  const nAiTotal   = feedback.filter(f => f.userLabel === "ai").length;
  const nRealTotal = feedback.filter(f => f.userLabel === "real").length;

  if (nAiTotal < MIN_SAMPLES_PER_CLASS || nRealTotal < MIN_SAMPLES_PER_CLASS) {
    console.log(`[AICD LR] Cold start — ${nAiTotal} AI, ${nRealTotal} Real (need ${MIN_SAMPLES_PER_CLASS} per class)`);
    await new Promise(r => chrome.storage.local.set({ lr_model: null }, r));
    return;
  }

  // Read all cached feature vectors
  const featEntries = await new Promise((resolve, reject) => {
    const req = db.transaction("feat_cache", "readonly")
                  .objectStore("feat_cache").getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
  const featMap = new Map(featEntries.map(e => [e.videoId, e.features]));

  // Join feedback with features — skip entries whose thumbnail hasn't been seen yet
  const samples = [];
  let skipped = 0;
  for (const entry of feedback) {
    const features = featMap.get(entry.videoId);
    if (!features) { skipped++; continue; }
    samples.push({ features, label: entry.userLabel === "ai" ? 1 : 0 });
  }

  const nAi   = samples.filter(s => s.label === 1).length;
  const nReal = samples.filter(s => s.label === 0).length;

  if (nAi < MIN_SAMPLES_PER_CLASS || nReal < MIN_SAMPLES_PER_CLASS) {
    console.log(`[AICD LR] Not enough cached features — ${nAi} AI, ${nReal} Real with features (${skipped} skipped)`);
    await new Promise(r => chrome.storage.local.set({ lr_model: null }, r));
    return;
  }

  const t0    = Date.now();
  const model = trainLR(samples);    // defined in lr.js
  console.log(`[AICD LR] Trained in ${Date.now() - t0}ms — ${nAi} AI, ${nReal} Real, ${skipped} skipped (no cached features)`);

  await new Promise(r => chrome.storage.local.set({ lr_model: model }, r));

  // Tell all open YouTube tabs to clear their L2 cache and re-score
  chrome.tabs.query({ url: "https://www.youtube.com/*" }, (tabs) => {
    tabs.forEach(tab =>
      chrome.tabs.sendMessage(tab.id, { type: "LR_MODEL_UPDATED" }).catch(() => {})
    );
  });
}

// Debounced retrain — batches rapid successive labels into one training run
let _retrainTimer = null;
function scheduleRetrain() {
  clearTimeout(_retrainTimer);
  _retrainTimer = setTimeout(() => trainOnStartup().catch(console.error), 3000);
}

// ---------------------------------------------------------------------------
// Maps videoId → tabId of the content script that requested the analysis.
const _pendingTabs = new Map();

// ---------------------------------------------------------------------------
// Diagnostic: feature distribution analysis
// Call from service worker console: diagFeatureStats()
// Prints per-class mean, diff, and Cohen's d for all 30 features, sorted by
// discriminability, so we can judge which features separate AI from Real.
// ---------------------------------------------------------------------------

const FEAT_NAMES = [
  "mean_sat",        "std_sat",       "hyper_sat_frac",   "mean_lightness",  "std_lightness",
  "R_entropy",       "G_entropy",     "B_entropy",        "hue_entropy",
  "top2_hue_conc",   "top1_hue_conc",
  "edge_frac",       "mean_grad",     "std_grad",         "edge_uniformity",
  "local_var",       "hifreq_ratio",  "block_artifact",   "oversharp",       "chrom_aberr",
  "skin_frac",       "bright_frac",   "dark_frac",        "center_bright",   "near_white_frac",
  "mean_R",          "mean_G",        "mean_B",           "color_temp",      "lum_variance",
];

async function diagFeatureStats() {
  const db = await openDb();
  const feedback = await getAllFeedback(db);

  // Read entire feat_cache store
  const featEntries = await new Promise((resolve, reject) => {
    const req = db.transaction("feat_cache", "readonly")
                  .objectStore("feat_cache").getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
  const featMap = new Map(featEntries.map(e => [e.videoId, e.features]));

  // Separate labeled samples that also have cached features
  const aiFeats   = [];
  const realFeats = [];
  for (const entry of feedback) {
    const f = featMap.get(entry.videoId);
    if (!f) continue;
    if (entry.userLabel === "ai")   aiFeats.push(f);
    if (entry.userLabel === "real") realFeats.push(f);
  }

  console.log(`[AICD diag] ${aiFeats.length} AI, ${realFeats.length} Real samples with cached features`);
  if (!aiFeats.length || !realFeats.length) {
    console.warn("[AICD diag] Need at least 1 sample per class.");
    return;
  }

  const N = FEAT_NAMES.length;

  function mean(samples) {
    const m = new Array(N).fill(0);
    for (const f of samples) for (let i = 0; i < N; i++) m[i] += f[i];
    return m.map(v => v / samples.length);
  }
  function std(samples, means) {
    const s = new Array(N).fill(0);
    for (const f of samples) for (let i = 0; i < N; i++) s[i] += (f[i] - means[i]) ** 2;
    return s.map(v => Math.sqrt(v / samples.length));
  }

  const aiMean   = mean(aiFeats);
  const realMean = mean(realFeats);
  const aiStd    = std(aiFeats,   aiMean);
  const realStd  = std(realFeats, realMean);

  const rows = FEAT_NAMES.map((name, i) => {
    const pooled  = Math.sqrt((aiStd[i] ** 2 + realStd[i] ** 2) / 2);
    const cohenD  = pooled > 1e-9 ? Math.abs(aiMean[i] - realMean[i]) / pooled : 0;
    const diff    = aiMean[i] - realMean[i];
    return {
      feature:   name,
      ai_mean:   +aiMean[i].toFixed(4),
      real_mean: +realMean[i].toFixed(4),
      diff:      +diff.toFixed(4),
      cohen_d:   +cohenD.toFixed(3),
      direction: diff > 0 ? "AI↑" : "AI↓",
    };
  });

  rows.sort((a, b) => b.cohen_d - a.cohen_d);

  console.log("\n[AICD diag] All features sorted by discriminability (Cohen's d):");
  console.table(rows);

  console.log("\n[AICD diag] Top 8 most discriminative features:");
  for (const r of rows.slice(0, 8)) {
    const bar = "█".repeat(Math.round(r.cohen_d * 10));
    console.log(
      `  ${r.feature.padEnd(18)} AI=${String(r.ai_mean).padStart(7)}  Real=${String(r.real_mean).padStart(7)}` +
      `  d=${String(r.cohen_d).padStart(5)}  ${r.direction}  ${bar}`
    );
  }
}

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
      console.log(`[AICD] STORE_FEEDBACK ${entry.userLabel} videoId=${entry.videoId} channelId=${entry.channelId || "(empty)"}`);
      openDb()
        .then((db) => storeFeedback(db, entry))
        .catch(() => {});
      updateChannelRep(entry.channelId, entry.userLabel);
      scheduleRetrain(); // retrain 3 s after the last label in a burst
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

    // Read lr_model here (background has chrome.storage access; offscreen does not)
    // and pass it along in the message so offscreen can run inference.
    (async () => {
      const data = await new Promise(r => chrome.storage.local.get("lr_model", r));
      await ensureOffscreen();
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_ANALYZE",
        videoId,
        thumbnailUrl,
        tabId,  // echoed back in OFFSCREEN_RESULT — survives service-worker restart
        lrModel: data.lr_model || null,
      }).catch((err) => console.warn("[AICD L2] Failed to reach offscreen:", err));
    })().catch((err) => {
      // Offscreen creation or storage read failed — resolve the content-script
      // promise with 0 so the card doesn't hang at "…" forever.
      console.warn("[AICD L2] pipeline failed:", err);
      _pendingTabs.delete(videoId);
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: "L2_RESULT", videoId, score: 0 }).catch(() => {});
      }
    });
    return false;
  }

  if (message.type === "OFFSCREEN_RESULT") {
    const { videoId, score, error, tabId: echoedTabId } = message;
    // Prefer the tabId echoed from offscreen (survives SW restart);
    // fall back to _pendingTabs for any in-flight requests sent before this fix.
    const tabId = echoedTabId ?? _pendingTabs.get(videoId);
    _pendingTabs.delete(videoId);

    if (!tabId) return false;

    if (error) {
      console.warn(`[AICD L2] ✗ ${videoId}:`, error);
      // Still resolve the content-script promise so thumbnail shows 0 instead of hanging.
      chrome.tabs.sendMessage(tabId, { type: "L2_RESULT", videoId, score: 0 }).catch(() => {});
      return false;
    }

    console.log(`[AICD L2] ✓ ${videoId} score=${score?.toFixed(3)}`);
    chrome.tabs.sendMessage(tabId, { type: "L2_RESULT", videoId, score })
      .catch(() => {});
    return false;
  }
});
