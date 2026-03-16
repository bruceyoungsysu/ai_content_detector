# AI Content Detector — Dev Log

A running record of architectural decisions, pivots, and progress.
Each session gets a dated entry at the bottom. Architecture sections above are kept current.

---

## Project Goal

A Chrome MV3 extension that labels YouTube video cards with AI-generated content badges.
Fully local — no API keys, no server, no data leaves the user's machine.
Accuracy improves over time through personal feedback.

---

## Current Architecture (as of 2026-03-02)

### Detection Layers

| Layer | Signal | Method | Latency |
|---|---|---|---|
| L1 | Title, hashtags, channel name | Hardcoded keywords + user-learned patterns | Sync (~0ms) |
| L2 | Thumbnail visual features | Hand-crafted image features + local logistic regression | Async (~200ms) |
| L3 | Channel history | Beta-smoothed reputation from user feedback | Sync (~0ms) |

### Score Combination

```
combined = 1 - (1 - s1) * (1 - s2) * (1 - s3)
```

Treats each layer as independent evidence. L3 is excluded when it has fewer than 2 labels
for the channel (score treated as neutral 0.5). L2 returns 0.0 (neutral) during cold-start
(fewer than 10 labeled examples per class) — no signal is better than a wrong signal.

**Badge thresholds:**
- `score >= 0.6` → AI Detected (red)
- `score >= 0.3` → Possibly AI (amber)
- `score < 0.3`  → Safe (no badge)

### Message Flow

```
YOUTUBE PAGE (content scripts: layer1.js, layer2.js, layer3.js, feedback-ui.js, content.js)

  content.js — processCard(el)
    ├─ L1: analyzeLayer1(el)          → s1   metadata heuristics + learned patterns (sync)
    ├─ L2: analyzeLayer2(videoId)     → s2   image features + logistic regression (async)
    ├─ L3: analyzeLayer3(channelId)   → s3   channel reputation (sync, local cache)
    └─ combined = 1-(1-s1)(1-s2)(1-s3) → badge

  feedback-ui.js — [AI] [Real] buttons hover-visible on each card
    └─ STORE_FEEDBACK → background.js

──────────── Chrome messaging ────────────

background.js (service worker)
  ├─ STORE_FEEDBACK
  │    ├─ writes FeedbackEntry to IndexedDB
  │    ├─ updateChannelRep(channelId, label)   → chrome.storage.local
  │    └─ learnPatterns(title, label)          → chrome.storage.local
  ├─ trainOnStartup()  [runs on every SW activation]
  │    ├─ reads feedback from IndexedDB (IDB is available in service workers)
  │    ├─ if ≥10 per class → asks offscreen to batch-extract features
  │    ├─ runs trainLR() in pure JS (~2ms)
  │    └─ saves lr_model to chrome.storage.local
  └─ L2_ANALYZE_THUMBNAIL → offscreen

offscreen.js (offscreen document — canvas available here)
  ├─ OFFSCREEN_ANALYZE
  │    ├─ fetch thumbnail → OffscreenCanvas(56×56)
  │    ├─ extractFeatures() → Float32Array[30]
  │    └─ predictLR(features, lr_model) → score → OFFSCREEN_RESULT
  └─ OFFSCREEN_EXTRACT_BATCH  [training support]
       ├─ batch-extract features for labeled thumbnails
       └─ cache in IndexedDB feat_cache store
```

### Storage Layout

```
chrome.storage.local
  ├─ enabled: bool
  ├─ lr_model: { weights[], bias, means[], stds[], trainedAt, nAi, nReal }
  ├─ channel_rep: { [channelId]: { score, n_ai, n_real, updatedAt } }
  └─ learned_patterns: string[]   (up to 500 user-extracted title n-grams)

IndexedDB "ai_cd_v1"
  ├─ feedback    { id*, videoId, channelId, channelName, title,
  │                thumbnailUrl, userLabel, timestamp }
  └─ feat_cache  { videoId*, features[], extractedAt }
```

### File Map

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `layer1.js` | Metadata heuristics + learned pattern scoring |
| `layer2.js` | Content-side L2 queue, cache, concurrency (unchanged) |
| `layer3.js` | Channel reputation reader |
| `feedback-ui.js` | [AI]/[Real] button widgets on video cards |
| `content.js` | Orchestrates all layers, renders badges |
| `content.css` | Badge + feedback button styles |
| `background.js` | Service worker: routing, training, reputation, patterns |
| `offscreen.html` | Shell page for canvas access |
| `offscreen.js` | Feature extraction + LR inference |
| `db.js` | IndexedDB wrapper (loaded in offscreen.html) |
| `features.js` | `computeFeatureVector()` — pure JS, 30 image features |
| `lr.js` | Logistic regression: `trainLR()` + `predictLR()` |
| `page-bridge.js` | Injected into MAIN world to read `ytInitialData` |
| `popup.html/js` | Extension popup with stats |

### L2 Feature Vector (30 features, computed on 56×56 thumbnail)

| Group | Features |
|---|---|
| Saturation stats | mean sat, std sat, hyper-sat fraction (>0.7), mean lightness, std lightness |
| Color histogram | R/G/B entropy, hue entropy, dominant-color concentration |
| Edge density | edge pixel fraction, mean gradient, std gradient, spatial uniformity |
| Texture | local variance mean, high-freq power ratio, block artifact score, over-sharpening score, chromatic aberration proxy |
| Face/text | skin-tone fraction, bright region fraction, dark region fraction, center weight, near-white fraction |
| Global | mean R, mean G, mean B, color temperature proxy, luminance variance |

### L3 Channel Reputation Formula

```
alpha = n_ai  + 1   (Laplace smoothing)
beta  = n_real + 1
score = alpha / (alpha + beta)
```

Returns 0.5 (neutral) with 0 labels. Needs ≥2 labels before contributing to score.

### Long-Term Migration Path

When enough labeled data exists (cross-user, opt-in):
1. Train a compact ONNX binary classifier externally (MobileNetV3-small or purpose-built CNN)
2. Re-introduce `ort.min.js` + WASM files
3. Replace `extractFeatures() + predictLR()` in offscreen.js with ONNX session inference
4. Layer2.js and content.js require zero changes — message protocol stays identical

---

## Implementation Phases

| # | Phase | Status | Key Deliverables |
|---|---|---|---|
| 1 | Remove broken model | `complete` | Delete EfficientNet-B0, ONNX Runtime; L2 returns neutral |
| 2 | IndexedDB layer | `complete` | `db.js` with feedback + feat_cache stores |
| 3 | Feedback UI | `pending` | `feedback-ui.js`, CSS buttons, `STORE_FEEDBACK` handler |
| 4 | Channel reputation | `pending` | `layer3.js`, Beta-smoothed rep, `CHANNEL_REP_UPDATED` broadcast |
| 5 | Image feature extraction | `pending` | `features.js`, 30-feature vector, offscreen canvas pipeline |
| 6 | Logistic regression | `pending` | `lr.js`, `trainOnStartup()` in background.js |
| 7 | L1 pattern learning | `pending` | `learnPatterns()`, layer1.js reads learned patterns |
| 8 | Popup stats | `pending` | Label counts, training status, accuracy estimate |

---

### Phase 1 — Remove Broken Model `complete`

**Goal:** Strip EfficientNet-B0 and ONNX Runtime. L2 returns 0 (neutral). Extension stays
functional via L1 only. No signal is better than a systematically wrong signal.

**Files changed:**
- `offscreen.js` — gutted to a 20-line stub returning `score: 0`
- `offscreen.html` — removed `ort.min.js` script tag
- `manifest.json` — removed `wasm-unsafe-eval` from CSP
- `background.js` — removed debug logits logging
- Deleted `export_model.py`, `setup_model.sh`

**Done when:** Extension loads without errors; L2 score is always 0; L1 badges still appear.

---

### Phase 2 — IndexedDB Layer `pending`

**Goal:** Persistent local storage that all other phases depend on. Stores user feedback
and a cache of extracted image feature vectors.

**Files to create:**
- `db.js` — loaded in `offscreen.html` before `offscreen.js`

**Database:** `"ai_cd_v1"`, version 1

**Stores:**

```
feedback   (keyPath: "id", autoIncrement)
  indexes: videoId, channelId, userLabel, timestamp
  fields:  id, videoId, channelId, channelName, title,
           thumbnailUrl, userLabel ("ai"|"real"), timestamp

feat_cache  (keyPath: "videoId")
  fields:  videoId, features (number[]), extractedAt
```

**API exported by db.js:**
```
openDb()                           → Promise<IDBDatabase>
storeFeedback(entry)               → Promise<number>   (inserted id)
getAllFeedback()                    → Promise<FeedbackEntry[]>
getFeedbackCount()                 → Promise<{ai, real}>
cacheFeatures(videoId, features)   → Promise<void>
getCachedFeatures(videoId)         → Promise<number[] | null>
```

**Note:** Service workers can also open IndexedDB directly (it's a standard Worker API).
`db.js` is loaded in the offscreen doc to handle feature caching alongside canvas ops.
`background.js` opens its own IDB connection for feedback reads/writes during training.

**Files to modify:**
- `offscreen.html` — add `<script src="db.js"></script>` before `offscreen.js`

**Done when:** Can open `chrome://extensions` → inspect offscreen document console and
call `openDb()` without errors; `storeFeedback()` and `getAllFeedback()` round-trip correctly.

---

### Phase 3 — Feedback UI `pending`

**Goal:** Non-intrusive [AI] / [Real] buttons on each YouTube card. Hover to reveal,
click to label. Labeled state persists visually for the session.

**Files to create:**
- `feedback-ui.js` — content script, loaded before `content.js`

**Widget HTML (injected once per card):**
```html
<div class="aicd-feedback" data-video-id="..." data-channel-id="...">
  <button class="aicd-fb-btn aicd-fb-ai"   aria-label="Mark as AI-generated">AI</button>
  <button class="aicd-fb-btn aicd-fb-real" aria-label="Mark as real">Real</button>
</div>
```

**Widget states:**
- `idle` — hidden, revealed on card hover
- `labeled-ai` — AI button filled red, Real faded; widget stays visible
- `labeled-real` — Real button filled green, AI faded; widget stays visible
- Clicking an active button un-labels (toggle back to idle)

**Message sent on click:**
```js
chrome.runtime.sendMessage({
  type: "STORE_FEEDBACK",
  entry: { videoId, channelId, channelName, title, thumbnailUrl, userLabel, timestamp }
})
```

**Files to modify:**
- `content.css` — add `.aicd-feedback`, `.aicd-fb-btn`, hover/active/labeled styles
- `content.js` — call `attachFeedbackWidget(el, videoId, channelId, channelName, title)`
  from `processCard()` after the L1 badge is set
- `layer1.js` — extract and expose `channelId` (`browseEndpoint.browseId`) from both
  `videoRenderer` and `lockupViewModel` metadata formats; add `getChannelId(el)` helper
- `background.js` — add `STORE_FEEDBACK` handler → writes to IndexedDB via IDB connection
- `manifest.json` — add `layer3.js`, `feedback-ui.js` to content_scripts (before `content.js`)

**Done when:** Buttons appear on hover; clicking AI/Real stores an entry in IndexedDB
(verify in DevTools → Application → IndexedDB → ai_cd_v1 → feedback).

---

### Phase 4 — Channel Reputation (L3) `pending`

**Goal:** Maintain a per-channel reputation score that reflects how often a user has
labeled that channel's videos as AI. Used as an immediate signal for unseen videos
from the same channel.

**Files to create:**
- `layer3.js` — content script, loaded before `content.js`

**Reputation formula (Beta distribution with Laplace smoothing):**
```
alpha = n_ai  + 1
beta  = n_real + 1
score = alpha / (alpha + beta)     → [0, 1], 0.5 = neutral
```

Behaviour at key counts:
- 0 labels: 0.50 (neutral — no contribution to score)
- 1 AI, 0 real: 0.67
- 5 AI, 0 real: 0.86
- 5 AI, 5 real: 0.50 (neutral — channel is mixed)

**Storage:** `chrome.storage.local` key `"channel_rep"`:
```js
{ [channelId]: { score, n_ai, n_real, updatedAt } }
```

**API exported by layer3.js:**
```js
initLayer3()              // loads channel_rep from storage into memory cache
analyzeLayer3(channelId)  // returns score in [0,1]; 0.5 if unknown or <2 labels
```

**Files to modify:**
- `background.js` — add `updateChannelRep(channelId, label)` called from `STORE_FEEDBACK`
  handler; broadcasts `CHANNEL_REP_UPDATED` to all YouTube tabs after each update
- `content.js` — call `analyzeLayer3(channelId)` in `processCard()`; update combination
  formula to three-way: `combined = 1 - (1-s1) * (1-s2) * (1-s3)`, excluding s3 when
  `Math.abs(s3 - 0.5) < 0.1` (not enough signal)

**Done when:** Labeling a video updates `channel_rep` in storage; the next video from the
same channel scores differently from a neutral channel.

---

### Phase 5 — Image Feature Extraction `pending`

**Goal:** Replace the neutral stub in `offscreen.js` with real thumbnail analysis.
Extract a 30-element feature vector from each thumbnail using only the canvas API —
no model files, no ONNX Runtime. Features are cached in IndexedDB.

**Files to create:**
- `features.js` — loaded in `offscreen.html` before `offscreen.js`

**Pipeline:**
```
thumbnailUrl
  → fetch (cors) → createImageBitmap
  → OffscreenCanvas(56, 56)            (small size — fast, enough for statistics)
  → ctx.getImageData → RGBA Uint8ClampedArray
  → computeFeatureVector(data, 56, 56) → Float32Array[30]
  → cache in IndexedDB feat_cache
```

**Feature groups (30 total):**
```
Saturation stats (5)   mean sat, std sat, hyper-sat fraction >0.7,
                       mean lightness, std lightness
Color histogram  (6)   R/G/B channel entropy, hue entropy,
                       dominant-color concentration (top-2 hue buckets / 32)
Edge density     (4)   edge pixel fraction (Sobel), mean gradient magnitude,
                       std gradient magnitude, spatial uniformity across 4 quadrants
Texture          (5)   local variance mean, high-freq power ratio,
                       block artifact score, over-sharpening score,
                       chromatic aberration proxy
Face/text        (5)   skin-tone pixel fraction, bright region fraction (L>0.85),
                       dark region fraction (L<0.1), center weight,
                       near-white fraction (sat<0.1, L>0.75)
Global           (5)   mean R, mean G, mean B, color temperature proxy (R-B),
                       luminance variance
```

**Files to modify:**
- `offscreen.html` — add `<script src="features.js"></script>` before `offscreen.js`
- `offscreen.js` — replace neutral stub with:
  1. `OFFSCREEN_ANALYZE`: fetch thumbnail → `computeFeatureVector()` → cache →
     call `predictLR(features, model)` → return score (still 0 if model not yet trained)
  2. `OFFSCREEN_EXTRACT_BATCH`: batch-process a list of `{videoId, thumbnailUrl}`,
     extract features and write to `feat_cache` IDB store, reply with
     `OFFSCREEN_EXTRACT_DONE`

**Done when:** Feature vectors appear in `feat_cache` store in DevTools IndexedDB
after viewing YouTube thumbnails.

---

### Phase 6 — Logistic Regression Classifier `pending`

**Goal:** Train a binary classifier from user feedback on extension startup. Weights
stored in `chrome.storage.local`. Inference runs in the offscreen document using
features from Phase 5. L2 becomes a real signal once ≥10 examples per class exist.

**Files to create:**
- `lr.js` — imported by `background.js` via `importScripts("lr.js")`

**API:**
```js
trainLR(samples, options)   // samples: [{features: number[], label: 0|1}]
                            // options: {lr, epochs, l2}  (defaults: 0.1, 200, 0.01)
                            // returns: {weights, bias, means, stds, trainedAt, nAi, nReal}

predictLR(features, model)  // returns P(AI) in [0, 1]
```

**Training algorithm:** Gradient descent logistic regression with z-score feature
normalisation and L2 regularisation. ~2ms for 100 samples, ~12ms for 1,000 samples.
Fits comfortably within service worker startup budget.

**Training trigger in background.js (`trainOnStartup()`):**
```
1. Read all feedback from IndexedDB
2. Count ai / real labels — if either < 10, save lr_model: null, return
3. Identify feedback entries without cached features
4. If any: ensureOffscreen() → send OFFSCREEN_EXTRACT_BATCH → await OFFSCREEN_EXTRACT_DONE
5. Build samples array from feedback + feat_cache
6. Call trainLR(samples) → save lr_model to chrome.storage.local
7. Broadcast LR_MODEL_UPDATED to all YouTube tabs
```

`trainOnStartup()` is called on `chrome.runtime.onInstalled` and service worker `activate`.

**Files to modify:**
- `background.js` — add `importScripts("lr.js")`, add `trainOnStartup()`, add
  `LR_MODEL_UPDATED` broadcast, update `OFFSCREEN_RESULT` handler path
- `offscreen.js` — `OFFSCREEN_ANALYZE` loads `lr_model` from storage and calls
  `predictLR(features, model)`; returns 0 if model is null (cold-start)
- `layer2.js` — no changes (message protocol unchanged)

**Done when:** After labeling ≥10 AI and ≥10 Real videos, reloading the extension
causes `[AICD LR] Trained: X AI, Y Real` to appear in the service worker console;
subsequent thumbnails receive non-zero scores.

---

### Phase 7 — L1 Pattern Learning `pending`

**Goal:** When a user labels a video as AI, extract meaningful n-grams from the title
and store them as personal learned signals. These supplement the hardcoded keyword
lists in `layer1.js` over time.

**Pattern extraction (runs in background.js on each AI-labeled feedback):**
```
1. Lowercase and strip punctuation from title
2. Split into words; remove stop words and short tokens (<3 chars)
3. Extract 1-grams and 2-grams not already covered by AI_PHRASES or AI_TOOLS
4. Add to learned_patterns set (capped at 500 to prevent storage bloat)
5. Save to chrome.storage.local
6. Broadcast LEARNED_PATTERNS_UPDATED to all YouTube tabs
```

Only AI-labeled videos contribute patterns. Real-labeled videos are ignored.

**Weight in layer1.js:** `learnedPattern: 0.55` (between `aiPhrase: 0.70` and
`aiSubjectVerb: 0.50`).

**Files to modify:**
- `background.js` — add `learnPatterns(title, label)` called from `STORE_FEEDBACK`
  handler; add `GET_LEARNED_PATTERNS` message handler; broadcast `LEARNED_PATTERNS_UPDATED`
- `layer1.js` — load learned patterns at `initLayer1()` via message to background;
  add `hasLearnedPattern(text)` check in `analyzeLayer1()`; listen for
  `LEARNED_PATTERNS_UPDATED` to refresh in-memory cache

**Done when:** Labeling a video as AI adds its title tokens to `learned_patterns` in
storage; a new video with a matching phrase scores higher from L1.

---

### Phase 8 — Popup Stats `pending`

**Goal:** Show the user the value their feedback is generating. Makes the training
loop visible and tells the user when the classifier becomes active.

**Popup states:**

```
Enough data (both classes ≥ 10):
  ✓ Classifier active
  47 labeled videos (23 AI · 24 Real)
  Last trained: 2 hours ago

Cold start (one class < 10):
  ◌ Classifier not yet active
  12 labeled videos (8 AI · 4 Real)
  Need 6 more Real to activate

No data:
  ◌ No labels yet
  Use the [AI] / [Real] buttons on video cards to start training.
```

**Files to modify:**
- `popup.html` — add stats panel below the existing toggle
- `popup.js` — on open: send `GET_FEEDBACK_COUNTS` to background → display counts
  and `lr_model` training status from `chrome.storage.local`
- `background.js` — add `GET_FEEDBACK_COUNTS` handler → queries IndexedDB and
  returns `{ai, real, trainedAt}` via `sendResponse`

**Done when:** Opening the popup shows accurate labeled counts and correctly reflects
whether the classifier is active or waiting for more data.

---

## Decision Log

---

### 2026-03-02

**Decision: Switch to fully local, feedback-driven architecture**

After testing the EfficientNet-B0 model (98.5% accuracy on its benchmark), we found it completely
fails on YouTube thumbnails. Rick Astley's 1987 music video scored 98.6% FAKE.

Root cause: the model was trained on natural camera photos vs. Midjourney/DALL-E/SDXL outputs.
YouTube thumbnails are professionally edited, color-graded, text-overlaid — neither distribution.
This is a domain mismatch that no pre-trained model (short of one trained specifically on YouTube
thumbnails) will solve.

**Resolution:** Build a fully local system that learns from the user's own feedback rather than
relying on any pre-trained model. Each user's extension personalizes to their viewing habits and
the channels they care about.

**Decision: Hand-crafted features + logistic regression for L2 (not neural net)**

Options considered:
- A. Hand-crafted image features + logistic regression in pure JS  ← chosen
- B. MobileNetV2 embeddings (1280-d) + logistic regression (needs 13MB model, same generalization problem)
- C. Cold-start only (no visual signal until enough data)

Chose A because: targets exactly the visual signatures of AI YouTube thumbnails; trains in ~2ms;
no model files needed; works with 10-20 examples per class; degrades gracefully to C during
cold-start.

**Decision: Beta-smoothed channel reputation instead of simple average**

Simple average is too volatile with few labels (1 label = 100% or 0%). Beta distribution with
Laplace smoothing (add 1 pseudo-count per class) gives sensible priors: unknown = neutral (0.5),
one strong signal = ~0.67, five consistent signals = ~0.86.

---

### 2026-02-XX  *(earlier session)*

**Decision: Switch from TF.js to ONNX Runtime Web**

TF.js required `tensorflowjs_converter` (Python + full TensorFlow, ~multi-GB install) to convert
models. Users of a browser extension cannot be asked to install TensorFlow.

ONNX Runtime Web (onnxruntime-web) provides a pure-JS runtime with WASM backend, and pre-trained
ONNX models can be downloaded directly from the ONNX Model Zoo with a simple `curl` command.

**Decision: Run all ML in offscreen document, not content script or service worker**

- Service workers: no DOM, no Canvas, no WebGL
- Content scripts: Canvas available but running ML there hurts page thread performance
- Offscreen documents: Canvas + WebGL available, never shown to user, isolated from page

All compute-heavy work (feature extraction, inference, training support) stays in offscreen.js.

**Decision: WASM blob URL workaround for ONNX Runtime**

ONNX Runtime Web spawns an internal Worker to load WASM. Chrome extension URLs
(`chrome-extension://...`) are not fetchable from within Workers. Fix: fetch both WASM
binaries as Blobs in the main offscreen-page context, create `blob:` URLs, and set these
as `ort.env.wasm.wasmPaths`. Workers can fetch `blob:` URLs freely.

Also required: `"wasm-unsafe-eval"` in the extension's `content_security_policy` to allow
WASM execution in extension pages under MV3.

**Decision: Layer 1 metadata heuristics as synchronous fast-path**

L1 runs synchronously from `ytInitialData` (tapped via `page-bridge.js` injected into the
MAIN world). It fires immediately and sets an initial badge. L2 and L3 update the badge
asynchronously when they resolve. This keeps the UI responsive — the user sees *some* signal
instantly, even before thumbnail analysis completes.

**Decision: Bayesian independent-evidence score combination**

`combined = 1 - (1 - s1) * (1 - s2) * ... * (1 - sN)`

Treats each layer as an independent witness. Properties:
- Any single very-high signal pushes combined toward 1 (high-confidence catch)
- All signals near 0 keeps combined near 0 (safe)
- Neutral signals (0.0) contribute nothing (correct cold-start behavior)
- Scales naturally to N layers without reweighting

---

### 2026-03-03

**Phase 1 complete: removed EfficientNet-B0 and ONNX Runtime**

EfficientNet-B0 (98.5% accuracy on its benchmark) was confirmed to completely
fail on YouTube thumbnails — Rick Astley's 1987 music video scored 98.6% FAKE.
Root cause: domain mismatch between training data (natural photos vs. AI art)
and YouTube thumbnails (professionally edited, color-graded, text-overlaid).

Changes made:
- `offscreen.js` — gutted to a ~20-line stub that returns `score: 0` (neutral)
  for all thumbnails. Canvas infrastructure will be rebuilt in Phase 5.
- `offscreen.html` — removed `ort.min.js` script tag
- `manifest.json` — removed `wasm-unsafe-eval` from CSP (no WASM needed)
- `background.js` — removed debug logits logging
- Deleted `export_model.py` and `setup_model.sh` (no longer needed)

The extension now runs on L1 only. L2 contributes a neutral score (0) which
has no effect on the Bayesian combination formula — correct cold-start behavior.

Next session: Phase 2 (IndexedDB layer — `db.js`).

**Phase 2 complete: IndexedDB layer**

Created `db.js` — the persistent storage foundation for all subsequent phases.
Loaded in `offscreen.html` before `offscreen.js` so it is available in the
offscreen document context where Canvas and IDB are both accessible.

Two stores in database `"ai_cd_v1"`:
- `feedback` — user-labeled videos, indexed by videoId / channelId / userLabel / timestamp
- `feat_cache` — extracted image feature vectors keyed by videoId

All functions take an open `IDBDatabase` as first argument (caller opens once,
reuses across calls) rather than reopening on every call.

**Phase 2 (cont): private seed file, popup stats, and export button**

Added persistence across extension reinstalls via a gitignored `data/private_seed.json`:

- `background.js` — `importScripts("db.js")`; `seedFromFile()` fetches
  `data/private_seed.json` on fresh install and imports any videoIds not already in IDB
- `manifest.json` — added `"downloads"` permission so popup can trigger file saves
- `popup.html` / `popup.js` — training data panel shows labeled count breakdown
  (AI vs. Real) and classifier status ("✓ Classifier active" when both ≥ 10 labels,
  otherwise "Need X more AI/Real to activate classifier");
  Export button downloads all IDB entries as `private_seed.json` via `chrome.downloads`
- `.gitignore` — `data/private_seed.json` is gitignored (personal labels only);
  `data/public_seed.json` reserved for a future community-curated seed
- `data/.gitkeep` — keeps the `data/` directory tracked in the repo

Workflow: Label videos → click Export → save as `data/private_seed.json` →
on next fresh install the labels are re-imported automatically.

Next session: Phase 3 (Feedback UI — `feedback-ui.js`, CSS buttons, `STORE_FEEDBACK`).

---

### 2026-03-15

**Phase 3 complete: Feedback UI**

Created `feedback-ui.js` — hover-visible [AI] / [Real] buttons on every YouTube video card.

Architecture decisions:
- Widget appended directly to the card element (same DOM level as the card), positioned
  `absolute` top-right. Idempotent — `attachFeedbackWidget` checks for `.aicd-feedback`
  before creating a new widget.
- Session label state stored in `_labeled` Map (videoId → "ai" | "real"). Survives SPA
  navigation without re-querying IDB because the Map persists in the content script.
- Widget visibility: always rendered at 35% opacity (CSS-only, no JS hover management).
  Full opacity on hover or when labeled. Earlier implementations tried JS `mouseenter`/
  `mouseleave` with 300ms delay but the feedback buttons disappeared when YouTube's video
  preview overlay captured pointer events. Opacity-based visibility is immune to this.
- `channelId` and `channelName` are re-read at **click time** (not attach time). This is
  critical: `_metaCache` may not be fully populated when `attachFeedbackWidget` runs
  (the page bridge response is async), but by the time the user clicks it always is.
- Context invalidation guard: `_sendFeedback` checks `chrome.runtime?.id` before calling
  `sendMessage`. Without this, reloading the extension while a tab is open throws
  `TypeError: Cannot read properties of undefined (reading 'sendMessage')`.

Files changed: `feedback-ui.js` (new), `content.js`, `content.css`, `background.js`,
`manifest.json`, `layer1.js` (added `getChannelId`, `getChannelName` helpers).

**Phase 3 bug fixes (discovered during testing)**

*Shorts cards not appearing:*
- Added `ytd-reel-item-renderer` to `querySelectorAll` in `content.js` and all CSS selectors.
- Added `/shorts/VIDEO_ID` URL pattern to `getVideoId()` in `layer1.js`.

*Channel page cards (/@handle/videos) not processed:*
- Added `ytd-grid-video-renderer` to `querySelectorAll` and CSS selectors.
- Extended `buildMeta()` in `layer1.js` to try `shortBylineText` for `channelId`
  (gridVideoRenderer uses this field instead of `ownerText`).

---

**Phase 4 complete: Channel Reputation (L3)**

Created `layer3.js` — per-channel reputation scoring using a Beta distribution with
Laplace smoothing.

Score formula: `(n_ai + 1) / (n_ai + n_real + 2)` → [0, 1], 0.5 = neutral.

Behaviour at representative label counts:
- 0 labels: 0.50 (neutral — no contribution to combined score)
- 1 AI, 0 Real: 0.67
- 5 AI, 0 Real: 0.86
- 5 AI, 5 Real: 0.50 (channel is mixed — neutral)

Storage: `chrome.storage.local` key `"channel_rep"`:
`{ [channelId]: { n_ai, n_real, score, updatedAt } }`

Live sync: background.js broadcasts `CHANNEL_REP_UPDATED` (with the updated entry) to
all open YouTube tabs after every `STORE_FEEDBACK` write. `layer3.js` updates its
in-memory `_repCache` on this message. `content.js` calls `applyFilter()` so all cards
from that channel immediately re-score without waiting for the next page load.

`initLayer3()` is called at bootstrap and on every `yt-navigate-finish` SPA navigation.

Files changed: `layer3.js` (new), `background.js`, `content.js`, `manifest.json`.

**Phase 4 bug fixes (discovered during testing)**

*`_pageChannelId` contaminating home feed:*
`extractPageChannelId()` was setting `_pageChannelId` on all pages. On the home feed this
caused every card to share the first channel's ID and flip together when one was labeled.
Fixed by guarding with a URL path check:
`/^\/(channel\/|c\/|user\/|@)/.test(window.location.pathname)`

*`buildLockupMeta` picking up non-channel browseIds:*
YouTube's lockupViewModel `commandRuns` can contain `browseId` values for topics,
playlists, and music genres — not just channels. Fixed by filtering for `id?.startsWith("UC")`
to accept only real channel IDs.

*DOM fallback missing `/@handle` links:*
Modern YouTube uses handle-style channel URLs. Added
`shadowQuery(cardEl, "a.yt-simple-endpoint[href*='/@']")` to the DOM fallback chain,
returning `"@" + handle` as the channelId key when no UC-id is available.

*L3 silent on first label (`< 2` threshold):*
`analyzeLayer3` had `if (rep.n_ai + rep.n_real < 2) return 0.5` which prevented
activation until 2 labels existed. Removed — Laplace smoothing already returns 0.5 at
zero labels, so the guard was redundant and caused the first label to have no effect.

*L3 score combination bug (Real label flipping badge to "Possibly AI"):*
The noisy-OR formula `1 - (1-s1)(1-s3)` only adds positive AI evidence — it treats
s3=0.333 (one Real label, Laplace) as "33% AI chance" which exceeded `THRESHOLD_POSSIBLE`.
Fixed by making L3 asymmetric around 0.5 in `combineWithL3()` in `content.js`:
- s3 > 0.5 (AI-leaning): standard noisy-OR boost → `1 - (1-base)(1-s3)`
- s3 < 0.5 (Real-leaning): linear dampen → `base × (2 × s3)`
  - s3=0.5 → ×1.0 (no change), s3=0.25 → ×0.5, s3=0 → zeroed out
- |s3−0.5| < 0.1: neutral dead zone → no effect

*Debug API added (`AICD_DIAG`):*
`content.js` listens for `window.postMessage({ type: "AICD_DIAG", videoId: "..." }, "*")`.
Prints to the page console: chrome.runtime status, pageChannelId, metaCache size,
per-video channelId/channel/title/s3, and the full `channel_rep` storage table.
Trigger from DevTools top-frame console — works even after extension context invalidation
(sync state printed first, async storage read gated on `chrome.runtime?.id`).

---

**Phase 5 complete: Image Feature Extraction**

Created `features.js` — extracts a 30-element feature vector from each thumbnail using
only the Canvas API. No model files, no runtime dependencies.

Resolution: **112×112** pixels (up from the originally planned 56×56 — four times the
pixel area, captures texture and saturation details that would be lost at 56×56).

Feature groups:

| Group | Indices | Features |
|---|---|---|
| Saturation stats | 0-4 | mean sat, std sat, hyper-sat fraction (>0.7), mean lightness, std lightness |
| Color histogram | 5-10 | R/G/B entropy, hue entropy, top-2 hue concentration, top-1 hue concentration |
| Edge density | 11-14 | edge pixel fraction (Sobel, threshold 0.05), mean gradient, std gradient, spatial uniformity (std of edge fraction across 4 quadrants) |
| Texture | 15-19 | local variance (3×3 patches), high-freq power ratio, block artifact score (8×8 boundary discontinuity), over-sharpening score, chromatic aberration proxy (mean \|R−B\| at edge pixels) |
| Face / text | 20-24 | skin-tone fraction, bright region fraction (L>0.85), dark region fraction (L<0.1), center brightness ratio, near-white fraction (S<0.1, L>0.75) |
| Global | 25-29 | mean R, mean G, mean B, color temperature proxy (R−B), luminance variance |

Pipeline:
```
thumbnailUrl → fetch (cors) → createImageBitmap
  → OffscreenCanvas(112, 112) → ctx.getImageData
  → computeFeatureVector(data, 112, 112) → Float32Array[30]
  → cacheFeatures(db, videoId, features)   ← stored in feat_cache IDB store
```

`offscreen.js` was rewritten to use this pipeline. `OFFSCREEN_ANALYZE` now:
1. Checks `feat_cache` for a cached vector (avoids re-fetching)
2. Fetches thumbnail, draws to OffscreenCanvas, calls `computeFeatureVector`
3. Caches result in IDB
4. Calls `predict(features)` — returns 0 if `predictLR` not yet defined (Phase 5
   graceful fallback); activates automatically once Phase 6 loads `lr.js`

Added `OFFSCREEN_EXTRACT_BATCH` handler for bulk feature extraction during training.

Files changed: `features.js` (new), `offscreen.js` (rewritten), `offscreen.html`.

**Empirical feature distribution analysis (post Phase 5)**

After accumulating 23 AI + 16 Real labeled videos with cached features, ran
`diagFeatureStats()` from the service worker console (diagnostic added to `background.js`).
Results sorted by Cohen's d (effect size):

| Feature | Cohen's d | Direction | Interpretation |
|---|---|---|---|
| mean_sat | 0.894 | AI↑ | Strongest signal — AI thumbnails ~35% more saturated |
| chrom_aberr | 0.603 | AI↑ | Surprising: AI has more colour contrast at edges (warm vs dark) |
| hyper_sat_frac | 0.574 | AI↑ | Nearly double the fraction of pixels with S>0.7 |
| mean_B | 0.541 | AI↓ | AI thumbnails have less blue — warmer palette |
| color_temp | 0.538 | AI↑ | AI thumbnails are warmer/more golden (Midjourney signature) |
| std_lightness | 0.493 | AI↓ | AI thumbnails have more uniform brightness |
| lum_variance | 0.478 | AI↓ | Less luminance variance — more uniformly lit |
| mean_lightness | 0.392 | AI↓ | AI thumbnails are darker on average |
| local_var | 0.367 | AI↓ | AI is smoother at pixel level (as expected) |

Notable weak features (d < 0.1): `B_entropy`, `hifreq_ratio`, `top2_hue_conc`,
`hue_entropy`, `edge_uniformity`, `block_artifact`. These are essentially noise at
this sample size and will be suppressed by L2 regularization in the LR classifier.

Conclusion: Saturation + warmth + darkness is a consistent, interpretable pattern.
The top ~10 features have genuine discriminative signal (d > 0.3). Proceeding to Phase 6
is justified. Accuracy ceiling estimated 70–80% given sample size and domain complexity.

Files changed: `background.js` (added `diagFeatureStats()` and `FEAT_NAMES` constant).

---

**Phase 6 complete: Logistic Regression Classifier**

Created `lr.js` — pure JS binary logistic regression. No dependencies.

**`trainLR(samples, options?)`**
- Input: `[{features: number[], label: 0|1}]` (1=AI, 0=Real)
- Z-score normalizes all features (per-feature mean and std computed from training set)
- Batch gradient descent: default 300 epochs, lr=0.1, L2 regularization λ=0.01
- L2 regularization is important given small dataset — prevents overfitting to
  dominant features like `mean_sat`
- Returns: `{weights, bias, means, stds, trainedAt, nAi, nReal}`
- Timing: ~2ms for 40 samples, ~15ms for 400 samples — fits within SW startup budget

**`predictLR(features, model)`**
- Applies same z-score normalization using stored means/stds
- Returns sigmoid(w·x + b) = P(AI) in [0, 1]

**Training pipeline in `background.js` (`trainOnStartup()`)**
1. Reads all feedback from IDB
2. If either class < `MIN_SAMPLES_PER_CLASS` (10) → saves `lr_model: null`, returns
3. Reads entire `feat_cache` IDB store, joins with feedback on `videoId`
4. Skips labeled videos with no cached features (user hasn't visited them recently)
5. Re-checks class counts after join — if still < 10 per class, aborts
6. Calls `trainLR(samples)` → saves result to `chrome.storage.local` as `"lr_model"`
7. Broadcasts `LR_MODEL_UPDATED` to all open YouTube tabs

**Training triggers:**
- `chrome.runtime.onInstalled` (install or update)
- `chrome.runtime.onStartup` (browser restart)
- `STORE_FEEDBACK` handler: debounced 3s retrain after each label burst (`scheduleRetrain()`)

This means the model is always up to date — labeling a video triggers a retrain 3
seconds later without any manual action from the user.

**Cache invalidation on model update:**
- `layer2.js` listens for `LR_MODEL_UPDATED` → clears `_l2Cache` (stale 0-scores)
- `content.js` listens for `LR_MODEL_UPDATED` → calls `applyFilter()` to re-score
  all visible cards with the new model

**`offscreen.js` activation:**
`predict()` already had `if (typeof predictLR !== "function") return 0` as a Phase 5
placeholder. Loading `lr.js` in `offscreen.html` before `offscreen.js` defines
`predictLR`, activating inference automatically with no further changes to `offscreen.js`.

Files changed: `lr.js` (new), `background.js`, `offscreen.html`, `layer2.js`, `content.js`.

**Per-layer score display (debugging aid)**

Added a real-time score overlay to every video card showing L1/L2/L3 and combined scores.
Positioned bottom-left of each card, 25% opacity normally, full opacity on hover.

Format: `L1:0.00  L2:0.35  L3:0.67  =0.78`

Each cell has a colour-coded top border: blue (L1 metadata), purple (L2 visual),
amber (L3 channel), grey→red/amber/green (combined, matches badge colour).

L2 shows `…` while the async offscreen inference is pending, then updates in place
when the result arrives.

Implementation: `updateScoreDisplay(cardEl, s1, s2, s3, combined)` in `content.js`
creates/updates a `.aicd-scores` div appended to the card. Called twice per card per
`processCard()` invocation: once after L1+L3 (sync, L2 pending), once after L2 resolves.

Files changed: `content.js`, `content.css`.

**Bug fix: L2 thumbnail score stuck at 0.00 for all videos**

Symptom: the per-layer score overlay showed `thumbnail:0.00` for every video, even
after the LR model was trained with ≥10 samples per class.

Root cause: `offscreen.js` `predict()` called `chrome.storage.local.get("lr_model")`
to load the trained model. However, **offscreen documents in MV3 only have access to
`chrome.runtime` messaging APIs** — `chrome.storage` is not available. The call threw
a `TypeError`, which was caught by the `.catch` on the `extractFeatures→predict` chain,
and the catch handler silently returned `score: 0`.

This went undetected because:
- Phase 5 never accessed `chrome.storage` in the offscreen document (features used
  IndexedDB, which is a standard Web API available everywhere)
- Phase 6 introduced the `chrome.storage.local.get("lr_model")` call in `predict()`
- The error was swallowed by the existing `.catch` → `score: 0` fallback, which is
  indistinguishable from a legitimate cold-start (no trained model)

Fix: moved model loading to `background.js` (which has full extension API access).
Background now reads `lr_model` from `chrome.storage.local` and passes it to the
offscreen document as part of the `OFFSCREEN_ANALYZE` message. `predict()` in
offscreen.js takes the model as a parameter instead of reading storage.

Files changed: `background.js`, `offscreen.js`.

---

## Next Steps

### Evaluate total score combination logic

Review whether the current score combination formula produces sensible results now
that all three layers are producing real signals. Specifically:

- Does the noisy-OR formula `1 - (1-s1)(1-s2)(1-s3)` weight each layer appropriately?
- Are the badge thresholds (0.6 AI, 0.3 Possibly AI) still correct with three active layers?
- Does the asymmetric L3 `combineWithL3()` (boost vs. dampen) behave well in practice?
- Are there cases where a single strong L2 score overwhelms weak L1/L3 signals (or vice versa)?

This should be done empirically by browsing YouTube with the score overlay visible and
checking whether the combined scores match intuition across a variety of channels and
video types.

---

### Phase 7 — L1 Pattern Learning (`pending`)

**Goal:** When a user labels a video as AI, extract meaningful n-grams from the title
and add them to a personal `learned_patterns` list in `chrome.storage.local`. These
supplement the hardcoded keyword lists in `layer1.js` over time, personalising the
metadata detector to the user's specific interests and the AI channels they encounter.

**Why this matters:** L1 is the only synchronous layer and fires before anything else.
Every new title pattern learned immediately benefits all future video cards on page load,
without waiting for L2 (async) or L3 (requires prior channel labels).

**Pattern extraction algorithm (runs in `background.js` on each AI-labeled STORE_FEEDBACK):**
1. Lowercase and strip punctuation from the video title
2. Split into tokens; remove stop words and short tokens (< 3 chars)
3. Extract 1-grams and 2-grams not already covered by `AI_PHRASES` or `AI_TOOLS`
4. Add new patterns to `learned_patterns` set (capped at 500 to prevent storage bloat)
5. Save to `chrome.storage.local`
6. Broadcast `LEARNED_PATTERNS_UPDATED` to all YouTube tabs

Only AI-labeled videos contribute patterns. Real-labeled videos are ignored (we don't
want to learn "not AI" patterns — that would suppress legitimate detections).

**Weight in `layer1.js`:** `learnedPattern: 0.55`
(between `aiPhrase: 0.70` and `aiSubjectVerb: 0.50`)

**Files to create/modify:**
- `background.js` — add `learnPatterns(title, label)`, `GET_LEARNED_PATTERNS` handler,
  `LEARNED_PATTERNS_UPDATED` broadcast
- `layer1.js` — load learned patterns via `GET_LEARNED_PATTERNS` message in `initLayer1()`;
  add `hasLearnedPattern(text)` check in `analyzeLayer1()`; listen for
  `LEARNED_PATTERNS_UPDATED` to refresh in-memory cache

**Done when:** Labeling a video as AI adds title tokens to `learned_patterns` in storage;
a new video with a matching phrase scores higher from L1 alone.

---

### Phase 8 — Popup Stats (`pending`)

**Goal:** Make the training loop visible to the user. The popup currently shows a basic
label count but doesn't reflect whether the classifier is active, how accurate it is, or
what the user needs to do next to improve it.

**Popup states:**

```
── When classifier is active (both classes ≥ 10 with cached features): ──
✓ Classifier active
47 labeled videos  (23 AI · 24 Real)
Last trained: 2 hours ago
Accuracy estimate: ~76%  (leave-one-out cross-validation)

── Cold start (one class < 10): ──
◌ Classifier training...
12 labeled videos  (8 AI · 4 Real)
Need 6 more Real labels to activate visual classifier

── No data: ──
◌ No labels yet
Use the [AI] / [Real] buttons on video cards to start training.
```

**Accuracy estimate:** Run leave-one-out cross-validation on the training set using
the saved model weights — one additional forward pass per sample at inference time,
~1ms total. Displayed as an honest "~X%" rather than a precise number (sample sizes
are too small for precise accuracy estimates).

**Files to modify:**
- `popup.html` — add stats panel (classifier status, label counts, training timestamp,
  accuracy estimate, "Retrain now" button)
- `popup.js` — on open: query `GET_FEEDBACK_COUNTS` + read `lr_model` from storage;
  compute and display all stats; "Retrain now" button sends `TRIGGER_TRAINING` message
- `background.js` — add `TRIGGER_TRAINING` message handler that calls `trainOnStartup()`

**Done when:** Opening the popup shows accurate label counts, classifier status,
last-trained timestamp, and an accuracy estimate that updates after each retrain.

---

### Long-Term: Phase 9+ — Cross-User Data and Better Model

Once enough labeled data exists (opt-in, privacy-preserving):

1. **Public seed file** — `data/public_seed.json` committed to the repo; provides a
   baseline set of known AI channels for new installs before the user has labeled anything.
   Currently `data/public_seed.json` is reserved but empty.

2. **Better visual model** — replace the hand-crafted LR with a compact ONNX binary
   classifier trained specifically on YouTube thumbnails (MobileNetV3-small or
   purpose-built CNN). The `layer2.js` message protocol is designed to require zero
   changes for this migration — only `offscreen.js` changes.

3. **Per-channel pattern learning** — extend Phase 7 to learn per-channel title patterns
   rather than a global list, so the detector can distinguish between two channels with
   similar naming conventions where only one is AI-generated.
