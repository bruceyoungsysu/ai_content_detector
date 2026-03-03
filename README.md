# AI Content Detector

[![License: PolyForm Noncommercial 1.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0-blue)](LICENSE)

A Chrome extension (Manifest V3) that labels YouTube video cards with a badge
indicating whether the content is likely AI-generated.

Detection runs locally — no API keys, no server, no data leaves your machine.
Accuracy improves over time through your own feedback.

> **Architecture details and decision history:** see [`DEVLOG.md`](./DEVLOG.md)

---

## How It Works

Three independent layers combine into a single score:

| Layer | Signal | Method |
|---|---|---|
| L1 | Title, hashtags, channel name | Keyword heuristics + user-learned patterns |
| L2 | Thumbnail image | Hand-crafted visual features + locally trained classifier |
| L3 | Channel history | Reputation built from your feedback |

Badges appear on video cards in the YouTube feed:

| Badge | Meaning | Score |
|---|---|---|
| 🔴 AI Detected | High confidence AI-generated | ≥ 0.6 |
| 🟡 Possibly AI | Weak signal | ≥ 0.3 |
| _(none)_ | Looks real | < 0.3 |

L2 and L3 start neutral and improve as you label videos using the **[AI] / [Real]**
buttons that appear on hover over each card.

---

## Setup

### 1. Install runtime assets (one-time)

```bash
./setup_model.sh
```

Downloads ONNX Runtime Web (JS + WASM files) from jsDelivr. Requires `curl`.

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this directory
4. Open YouTube

---

## Development

```
manifest.json       MV3 manifest
background.js       Service worker — message routing, training, reputation
content.js          Orchestrates all layers, renders badges
layer1.js           Metadata heuristics + learned pattern scoring
layer2.js           Content-side L2 queue/cache/concurrency
layer3.js           Channel reputation reader
feedback-ui.js      [AI] / [Real] buttons on video cards
offscreen.html/js   Canvas feature extraction (offscreen document)
db.js               IndexedDB wrapper (feedback + feature cache)
features.js         30-feature image feature vector (pure JS)
lr.js               Logistic regression: train + predict (pure JS)
page-bridge.js      Reads window.ytInitialData from MAIN world
content.css         Badge + feedback button styles
popup.html/js       Toolbar popup — toggle + training stats
setup_model.sh      Downloads ORT runtime files
```

Files not committed (downloaded by `setup_model.sh`):
```
ort.min.js  ort-wasm.wasm  ort-wasm-simd.wasm
```
