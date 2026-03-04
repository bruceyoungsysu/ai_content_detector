// db.js — IndexedDB wrapper for AI Content Detector.
// Loaded in offscreen.html (before offscreen.js) where IDB is available.
// background.js opens its own connection directly for feedback reads during training.
//
// Database: "ai_cd_v1", version 1
// Stores:
//   feedback   — user-labeled videos (keyPath: "id", autoIncrement)
//   feat_cache — extracted image feature vectors (keyPath: "videoId")

const DB_NAME    = "ai_cd_v1";
const DB_VERSION = 1;

// ---------------------------------------------------------------------------
// Open / upgrade
// ---------------------------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      // feedback store
      if (!db.objectStoreNames.contains("feedback")) {
        const store = db.createObjectStore("feedback", {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("videoId",   "videoId",   { unique: false });
        store.createIndex("channelId", "channelId", { unique: false });
        store.createIndex("userLabel", "userLabel", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }

      // feat_cache store
      if (!db.objectStoreNames.contains("feat_cache")) {
        db.createObjectStore("feat_cache", { keyPath: "videoId" });
      }
    };

    req.onsuccess = (event) => resolve(event.target.result);
    req.onerror   = (event) => reject(event.target.error);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ---------------------------------------------------------------------------
// feedback store
// ---------------------------------------------------------------------------

/**
 * Store a user feedback entry.
 * @param {IDBDatabase} db
 * @param {{videoId, channelId, channelName, title, thumbnailUrl,
 *          userLabel: "ai"|"real", timestamp}} entry
 * @returns {Promise<number>} auto-assigned id
 */
function storeFeedback(db, entry) {
  const tx    = db.transaction("feedback", "readwrite");
  const store = tx.objectStore("feedback");
  return promisifyRequest(store.add(entry));
}

/**
 * Return all feedback entries, ordered by insertion (ascending id).
 * @param {IDBDatabase} db
 * @returns {Promise<Array>}
 */
function getAllFeedback(db) {
  const tx    = db.transaction("feedback", "readonly");
  const store = tx.objectStore("feedback");
  return promisifyRequest(store.getAll());
}

/**
 * Return counts of each label.
 * @param {IDBDatabase} db
 * @returns {Promise<{ai: number, real: number}>}
 */
async function getFeedbackCount(db) {
  const tx    = db.transaction("feedback", "readonly");
  const store = tx.objectStore("feedback");
  const index = store.index("userLabel");
  const [ai, real] = await Promise.all([
    promisifyRequest(index.count(IDBKeyRange.only("ai"))),
    promisifyRequest(index.count(IDBKeyRange.only("real"))),
  ]);
  return { ai, real };
}

// ---------------------------------------------------------------------------
// feat_cache store
// ---------------------------------------------------------------------------

/**
 * Write or overwrite a feature vector for a videoId.
 * @param {IDBDatabase} db
 * @param {string} videoId
 * @param {number[]} features
 */
function cacheFeatures(db, videoId, features) {
  const tx    = db.transaction("feat_cache", "readwrite");
  const store = tx.objectStore("feat_cache");
  return promisifyRequest(store.put({ videoId, features, extractedAt: Date.now() }));
}

/**
 * Read a cached feature vector, or null if not found.
 * @param {IDBDatabase} db
 * @param {string} videoId
 * @returns {Promise<number[] | null>}
 */
async function getCachedFeatures(db, videoId) {
  const tx    = db.transaction("feat_cache", "readonly");
  const store = tx.objectStore("feat_cache");
  const entry = await promisifyRequest(store.get(videoId));
  return entry?.features ?? null;
}
