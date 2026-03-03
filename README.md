# AI Content Detector

A Chrome extension (Manifest V3) that labels YouTube video cards with a badge
indicating whether the thumbnail and metadata suggest AI-generated content.
Detection runs in two independent layers whose scores are combined before the
badge is rendered.

---

## Table of Contents

1. [File Map](#file-map)
2. [High-Level Architecture](#high-level-architecture)
3. [Layer 1 — Metadata Heuristics](#layer-1--metadata-heuristics)
4. [Layer 2 — Thumbnail Classification](#layer-2--thumbnail-classification)
5. [Score Combination](#score-combination)
6. [Badge Rendering](#badge-rendering)
7. [Extension State & Popup](#extension-state--popup)
8. [Message Reference](#message-reference)
9. [Setup & Installation](#setup--installation)
10. [Known Limitations & Future Work](#known-limitations--future-work)

---

## File Map

```
manifest.json          Extension manifest (MV3)
background.js          Service worker — state relay, offscreen lifecycle, L2 routing
content.js             Content script — orchestration, badge writes
layer1.js              Content script — metadata heuristics (loaded before content.js)
layer2.js              Content script — L2 queue/cache (loaded before content.js)
offscreen.html         Offscreen document shell (loads ort.min.js + offscreen.js)
offscreen.js           ONNX Runtime inference host — model load, preprocess, score
page-bridge.js         MAIN-world script — taps window.ytInitialData and fetch
content.css            Badge styles (::before pseudo-elements, no DOM injection)
popup.html / popup.js  Toolbar popup — on/off toggle
setup_model.sh         One-time dev script — downloads ORT + WASM + ONNX model
ort.min.js             ONNX Runtime Web 1.18.0 JS bundle (downloaded by setup_model.sh)
ort-wasm.wasm          ORT WASM backend — base (downloaded by setup_model.sh)
ort-wasm-simd.wasm     ORT WASM backend — SIMD-optimised (downloaded by setup_model.sh)
mobilenet/
  mobilenet_v2.onnx    MobileNet V2 ONNX model from ONNX Model Zoo (downloaded by setup_model.sh)
```

---

## High-Level Architecture

```
YouTube tab                    background.js (SW)          offscreen.html
─────────────────────          ──────────────────          ──────────────
layer1.js
  analyzeLayer1(el) ──────────────────────────────────────────────────► (sync)
  → s1 score
  → set badge immediately

layer2.js
  analyzeLayer2(id) ──L2_ANALYZE_THUMBNAIL──► ensureOffscreen()
                                              │
                                              └──OFFSCREEN_ANALYZE──► fetch thumbnail
                                                                       preprocess
                                                                       MobileNet predict
                                              ◄──OFFSCREEN_RESULT───  computeAiScore()
                    ◄──L2_RESULT─────────────
  → s2 score

content.js
  combined = Bayesian(s1, s2)
  → update badge
```

Content scripts run in the YouTube tab. The service worker acts as a message
broker and manages the offscreen document lifecycle. The offscreen document is
the only execution context where TF.js can access Canvas and (optionally) WebGL
— neither service workers nor content scripts are appropriate for ML inference
(no DOM in the former; page-performance impact in the latter).

---

## Layer 1 — Metadata Heuristics

**File:** `layer1.js`
**Execution context:** Content script (YouTube tab)
**Latency:** Synchronous — completes in < 1 ms per card

### Data Sources

Layer 1 needs rich video metadata (description, tags, badges) that is not
present in the DOM but is embedded in the page's JavaScript. Two mechanisms
feed it:

#### 1. `window.ytInitialData` (initial page load)

YouTube inlines a large JSON object (`window.ytInitialData`) into every page.
Content scripts run in an isolated world and cannot read `window` variables
from the page. `page-bridge.js` is injected into the **MAIN** world, where it
can read `ytInitialData` and relay it back via `window.postMessage`.

```
content-script world                  MAIN world (page-bridge.js)
─────────────────────                 ──────────────────────────────
postMessage(AICD_REQUEST_YT_DATA) ──► read window.ytInitialData
                                  ◄── postMessage(AICD_YT_DATA_RESPONSE, data)
```

A 3-second timeout guards against pages where the variable is absent.

#### 2. YouTube continuation fetches (infinite scroll / navigation)

YouTube's SPA loads more videos via internal API calls to:
- `/youtubei/v1/browse` — home feed, channels, subscriptions
- `/youtubei/v1/search` — search results
- `/youtubei/v1/next` — watch-page recommendations

`page-bridge.js` monkey-patches `window.fetch` in the MAIN world to intercept
these responses and forward them as `AICD_YT_CONTINUATION` messages. The
content script picks them up and adds the new video metadata to `_metaCache`.

#### Meta cache

`_metaCache` is a `Map<videoId, VideoMeta>`. It is built once per page load and
invalidated on SPA navigation (`yt-navigate-finish`). If a card's videoId is
missing from the cache (race condition during initial paint), the scorer falls
back to reading the title directly from the DOM.

### YouTube Data Format Support

YouTube has two card renderer formats and `walkForVideos` handles both:

| Format | Identifier | Fields available |
|---|---|---|
| **Legacy** `videoRenderer` | `node.videoId` is a string and `node.title` exists | title, description, channel, badges, tags |
| **New** `lockupViewModel` (2024+) | `node.contentType === "LOCKUP_CONTENT_TYPE_VIDEO"` | title, channel only (no description/tags in this format) |

### Signal Dictionary Design

Three types of hard-coded keyword lists are checked against the
lowercased concatenation of `title + description + tags`:

| List | Contents | Size |
|---|---|---|
| `AI_HASHTAGS` | `Set` of known AI-disclosure hashtags | 29 entries |
| `AI_TOOLS` | Array of AI tool/product names | 28 entries |
| `AI_PHRASES` | Array of explicit disclosure phrases | 26 entries |

A fourth check uses a regex on the title only:

```js
const AI_SUBJECT_VERBS = /\bai\s+(interview|narrate|voice|sing|...)\b/i
```

This matches constructions like "AI interviews celebrities" where AI is the
performing grammatical subject. It has a higher false-positive rate than
explicit tool names, so it carries a lower weight.

A fifth check (`hasAiChannelName`) runs a separate regex against the channel
name field only.

YouTube's own content label is checked via the `badges` array, which surfaces
the `metadataBadgeRenderer` label/tooltip strings from the API response.

### Scoring

Each triggered signal adds its weight to a running total, capped at 1.0:

```
Signal                Weight   Rationale
─────────────────────────────────────────────────────────────────────
YouTube disclosure    0.95     Platform's own label — near-definitive
AI hashtag            0.80     Explicit self-disclosure by creator
AI tool name          0.75     Strong: tool names rarely appear accidentally
AI phrase             0.70     Strong: disclosure phrases are intentional
AI-subject verb       0.50     Weaker: higher false-positive rate
Channel name match    0.35     Weakest: channel names are noisy
```

Weights are **additive** (not independent-evidence). The design choice is that
co-occurring signals (e.g., hashtag + tool name) should confidently push the
score above the `THRESHOLD_AI` threshold. The cap at 1.0 prevents the sum from
exceeding the valid range.

The `triggered` array is computed alongside the score and is available for
future logging/debugging — it is not currently surfaced in the UI.

---

## Layer 2 — Thumbnail Classification

**Files:** `layer2.js` (content script), `offscreen.js` + `offscreen.html`
**Execution context:** Content script queues requests; inference runs in the offscreen document
**Latency:** Asynchronous — typically 200–800 ms after the first model warmup

### Why an Offscreen Document

| Context | Canvas / WASM | Acceptable for ML? |
|---|---|---|
| Service worker | No | No |
| Content script | Yes | No — blocks page thread |
| Offscreen document | Yes | Yes |

Chrome MV3 service workers have no DOM. Content scripts share the page's
rendering thread — running a full forward pass there would cause jank. An
offscreen document is a headless Chromium page attached to the extension;
it has full DOM and WASM access while being entirely invisible to the user.

### Runtime: ONNX Runtime Web

ONNX Runtime Web (`onnxruntime-web`) was chosen over TF.js because:
- **Smaller JS bundle**: ~400 KB vs ~1.4 MB for TF.js
- **Broader model ecosystem**: any PyTorch or TensorFlow model can be exported
  to ONNX, so upgrading to a fine-tuned binary classifier is straightforward
- **No conversion tool needed**: ONNX models load directly — no Python or
  `tensorflowjs_converter` required
- **Faster startup**: WASM backend initialises quicker than TF.js WebGL backend
- **Active development**: currently the most popular runtime for in-browser ML

The WASM binaries (`ort-wasm.wasm`, `ort-wasm-simd.wasm`) are bundled with the
extension. Their paths are set explicitly via `ort.env.wasm.wasmPaths` so ORT
never tries to fetch them from a CDN at runtime.

### Model: MobileNet V2

- Architecture: MobileNet V2, multiplier 1.0, 224×224 input
- Source: ONNX Model Zoo (`mobilenetv2-12.onnx`)
- Format: ONNX opset 12 — loads with `ort.InferenceSession.create()`
- Input: `[1, 3, 224, 224]` float32, NCHW, ImageNet-normalised
- Output: `[1, 1000]` float32 logits over 1000 ImageNet classes
- Size: ~14 MB

Input and output node names are read dynamically from `session.inputNames[0]`
and `session.outputNames[0]` rather than being hardcoded.

The session is created lazily on the first inference request and kept as a
singleton (`_sessionPromise`).

### Preprocessing Pipeline

```
thumbnailUrl (https://i.ytimg.com/vi/{id}/hqdefault.jpg)
  │
  ▼ fetch({ mode: "cors" })            — host_permissions covers i.ytimg.com
  │
  ▼ createImageBitmap(blob)            — hardware-accelerated JPEG decode + resize
  │
  ▼ OffscreenCanvas(224, 224)
    ctx.drawImage(bitmap, 0,0,224,224)
    ctx.getImageData(0,0,224,224)       — RGBA Uint8ClampedArray (HWC layout)
  │
  ▼ Manual HWC→CHW loop                — convert RGBA HWC to RGB CHW (NCHW)
    (x / 255 − mean[c]) / std[c]       — ImageNet per-channel normalisation
  │
  ▼ new ort.Tensor('float32', …, [1,3,224,224])
```

All preprocessing runs in plain JS — no tensor library needed until the ONNX
session `run()` call.

### Score Heuristic (MVP)

MobileNet V2 was trained for general-purpose ImageNet classification, not for
AI-vs-real detection. The heuristic exploits the observation that AI-generated
images tend to activate many ImageNet classes diffusely (because they blend
textures from many objects), whereas natural photographs usually have a clear
dominant subject.

```
probs = softmax(logits)                         // [1000] probabilities (pure JS)

topProb           = max(probs)                  // peak class probability
entropy           = −Σ p·log(p)                 // Shannon entropy
normalizedEntropy = entropy / log(1000)         // scaled to [0, 1]

score = normalizedEntropy × 0.6 + (1 − topProb) × 0.4
```

| Component | Weight | Intuition |
|---|---|---|
| Normalized entropy | 0.6 | AI images: diffuse distribution → high entropy |
| 1 − top probability | 0.4 | AI images: no clear dominant class → low peak |

The softmax is computed in plain JavaScript using the numerically stable
max-subtraction trick (`exp(x − max)`) — no tensor library call needed.

**This is the only function that needs to change** (`computeAiScore` in
`offscreen.js`) when a properly trained binary classifier is available.

### Concurrency & Caching in `layer2.js`

`processCard` is called for every card on every DOM mutation batch. Without
throttling, a feed with 30 cards would fire 30 simultaneous inference requests.

```
_l2Cache   Map<videoId, score>    Persists resolved scores; cache hit → instant return
_inFlight  Set<videoId>           Guards against duplicate dispatches
_waiters   Map<videoId, [fn...]>  Multiple callers for the same videoId share one request
_queue     videoId[]              Backlog waiting for a concurrency slot
_active    number                 Current in-flight count (max = MAX_CONCURRENT = 3)
```

**Piggyback pattern:** If `analyzeLayer2("abc")` is called a second time while
the first is still in-flight, the second caller's resolve function is pushed
onto `_waiters.get("abc")`. When `L2_RESULT` arrives, all waiters are resolved
in one pass — only one network round-trip + inference ever runs per videoId
per page load.

**Queue drain:** `_drainQueue()` is called both when a new request is enqueued
and when a result arrives (freeing a slot). This ensures the queue always
makes forward progress at the maximum allowed concurrency.

---

## Score Combination

```
combined = 1 − (1 − s1) × (1 − s2)
```

This is the **independent-evidence Bayesian update** formula. It treats Layer 1
(metadata) and Layer 2 (visual) as independent sensors. Intuitively:

- If either layer is highly confident (score near 1), the combined score is
  pulled strongly toward 1 regardless of the other.
- If both layers are uncertain (scores near 0.5), the combined score is higher
  than either alone (~0.75), reflecting that two weak signals agreeing is more
  meaningful than one.
- If one layer scores 0 and the other scores 0, the combined score is 0.

The badge is written **twice**: once immediately from s1 (synchronous, no
visible delay) and once after s2 resolves (asynchronous update). The
`el.isConnected` guard prevents stale DOM writes when the card has scrolled
off-screen and been recycled by YouTube's virtual list.

---

## Badge Rendering

Badges are CSS `::before` pseudo-elements — no DOM nodes are injected into
YouTube's shadow DOM. The content script sets a single HTML attribute:

```
data-aicd="safe"      →  "Not AI"      (green,  score < 0.3)
data-aicd="possible"  →  "Possibly AI" (amber,  0.3 ≤ score < 0.6)
data-aicd="ai"        →  "AI Detected" (red,    score ≥ 0.6)
```

Thresholds (`content.js`):

```
THRESHOLD_AI       = 0.6
THRESHOLD_POSSIBLE = 0.3
```

The `::before` approach avoids any risk of breaking YouTube's Polymer/LitElement
component lifecycle, keeps the CSS selector surface small, and means the badge
disappears automatically if the attribute is removed (extension disabled).

The MutationObserver in `content.js` observes only `{ childList: true, subtree:
true }` — **not** `attributes`. This means the observer is never triggered by
the extension's own `setAttribute("data-aicd", …)` writes, preventing an
infinite re-processing loop.

---

## Extension State & Popup

Extension state is a single boolean (`enabled`) stored in `chrome.storage.local`.

- On install: initialized to `true`.
- The popup reads state via `GET_STATE` and writes via `SET_ENABLED`.
- `background.js` receives `SET_ENABLED`, persists it, and fans it out to all
  open YouTube tabs.
- Each content script re-runs `applyFilter()` on receipt, immediately clearing
  or re-applying all badges.

---

## Message Reference

| Type | Direction | Sender | Payload | Purpose |
|---|---|---|---|---|
| `GET_STATE` | content/popup → SW | any | — | Request `{ enabled }` |
| `SET_ENABLED` | popup → SW → tabs | popup | `{ enabled: bool }` | Toggle extension |
| `L2_ANALYZE_THUMBNAIL` | content → SW | layer2.js | `{ videoId }` | Request L2 inference |
| `OFFSCREEN_ANALYZE` | SW → offscreen | background.js | `{ videoId, thumbnailUrl }` | Trigger inference |
| `OFFSCREEN_RESULT` | offscreen → SW | offscreen.js | `{ videoId, score, error? }` | Inference result |
| `L2_RESULT` | SW → tab | background.js | `{ videoId, score }` | Deliver score to content script |

---

## Setup & Installation

### 1. Download model assets (one-time)

```bash
cd /path/to/ai_content_detector
./setup_model.sh
```

No Python packages or conversion tools needed. The script uses only `curl` and
Python's built-in `json` module (to parse shard filenames from `model.json`).

It downloads:
- `ort.min.js` — ONNX Runtime Web 1.18.0 JS bundle from jsDelivr (~400 KB)
- `ort-wasm.wasm` + `ort-wasm-simd.wasm` — WASM backends bundled with ORT
- `mobilenet/mobilenet_v2.onnx` — MobileNet V2 from the ONNX Model Zoo (~14 MB)

No Python, TensorFlow, or model conversion tools required.

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the extension directory
4. Open YouTube — badges should appear immediately from Layer 1

### 3. Verify Layer 2

- Open DevTools → Application → Service Workers to confirm the background
  script is alive.
- Open the background page console and confirm `[AICD L2] Offscreen document
  created` appears when you load a YouTube page.
- `[AICD L2] MobileNet loaded and warmed up` should follow within a few
  seconds on first use.
- Scroll the YouTube feed — `L2_RESULT` messages should appear in the console.

---

## Known Limitations & Future Work

### Layer 1

- Keyword lists require manual maintenance as new AI tools emerge.
- Additive scoring does not model signal overlap correctly; two co-occurring
  signals can push the score past 1.0 before the clamp, masking the individual
  contributions.
- The `lockupViewModel` format does not expose description or tags, reducing
  signal richness for newer card layouts.
- The AI-subject-verb regex has a meaningful false-positive rate (e.g., "AI
  explains how photosynthesis works" — likely human-narrated educational video).

### Layer 2

- MobileNet is trained on natural ImageNet photographs, not on the
  AI-vs-real binary task. The entropy/top-1 heuristic is a proxy and produces
  false positives on complex natural scenes and false negatives on photorealistic
  AI thumbnails with clear subjects.
- `_pendingTabs` maps videoId → single tabId. If the same video appears in two
  tabs simultaneously, only the second tab receives the L2 update.
- There is no timeout on in-flight L2 requests. If the service worker is
  terminated mid-flight, `_active` in the content script never decrements and
  the queue stalls for those slots until the page is reloaded. (MAX_CONCURRENT
  = 3 limits the blast radius.)
- The full 14 MB of MobileNet weights ships inside the extension package,
  inflating the `.crx` download size.

### Planned upgrades

| Area | Change |
|---|---|
| L2 model | Replace `computeAiScore()` in `offscreen.js` with a fine-tuned binary classifier head trained on labelled AI / real thumbnails |
| L1 scoring | Switch to probabilistic (independent-evidence) combination instead of additive sum |
| L2 model | Explore a lighter model (MobileNet v3 Small) or quantised weights to reduce package size |
| L2 reliability | Add a per-request timeout + `_active` recovery path for SW termination |
| Multi-tab | Store `_pendingTabs` as a `Map<videoId, Set<tabId>>` to notify all tabs |
| UI | Add a "why" tooltip on the badge showing which signals triggered |
