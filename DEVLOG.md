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
| 2 | IndexedDB layer | `pending` | `db.js` with feedback + feat_cache stores |
| 3 | Feedback UI | `pending` | `feedback-ui.js`, CSS buttons, `STORE_FEEDBACK` handler |
| 4 | Channel reputation | `pending` | `layer3.js`, Beta-smoothed rep, `CHANNEL_REP_UPDATED` broadcast |
| 5 | Image feature extraction | `pending` | `features.js`, 30-feature vector, offscreen canvas pipeline |
| 6 | Logistic regression | `pending` | `lr.js`, `trainOnStartup()` in background.js |
| 7 | L1 pattern learning | `pending` | `learnPatterns()`, layer1.js reads learned patterns |
| 8 | Popup stats | `pending` | Label counts, training status, accuracy estimate |

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

*Add new entries at the bottom with today's date when starting a session.*
