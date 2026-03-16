// lr.js — Logistic regression classifier for thumbnail AI detection.
// Loaded in offscreen.html (inference) and background.js via importScripts (training).
//
// API:
//   trainLR(samples, options?) → model
//   predictLR(features, model) → P(AI) in [0, 1]
//
// model: { weights, bias, means, stds, trainedAt, nAi, nReal }

const LR_DEFAULTS = { lr: 0.1, epochs: 300, l2: 0.01 };

/**
 * Train a logistic regression classifier on labeled feature vectors.
 * Features are z-score normalized internally; normalization params are stored
 * in the model so predictLR can apply the same transform at inference time.
 *
 * @param {{features: number[], label: 0|1}[]} samples  (1 = AI, 0 = Real)
 * @param {{lr?: number, epochs?: number, l2?: number}} options
 * @returns {object} trained model
 */
function trainLR(samples, options = {}) {
  const { lr, epochs, l2 } = { ...LR_DEFAULTS, ...options };
  const n = samples.length;
  const d = samples[0].features.length;

  // ── Z-score normalization ──────────────────────────────────────────────────
  const means = new Array(d).fill(0);
  const stds  = new Array(d).fill(0);

  for (const s of samples) {
    for (let i = 0; i < d; i++) means[i] += s.features[i];
  }
  for (let i = 0; i < d; i++) means[i] /= n;

  for (const s of samples) {
    for (let i = 0; i < d; i++) stds[i] += (s.features[i] - means[i]) ** 2;
  }
  for (let i = 0; i < d; i++) {
    stds[i] = Math.sqrt(stds[i] / n) || 1; // guard: zero-variance feature → std=1
  }

  const X = samples.map(s => s.features.map((v, i) => (v - means[i]) / stds[i]));
  const y = samples.map(s => s.label);

  // ── Batch gradient descent ─────────────────────────────────────────────────
  const w = new Array(d).fill(0);
  let b = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const dw = new Array(d).fill(0);
    let db = 0;

    for (let j = 0; j < n; j++) {
      let z = b;
      for (let i = 0; i < d; i++) z += w[i] * X[j][i];
      const p   = 1 / (1 + Math.exp(-z)); // sigmoid — JS handles ±Infinity cleanly
      const err = p - y[j];
      for (let i = 0; i < d; i++) dw[i] += err * X[j][i];
      db += err;
    }

    for (let i = 0; i < d; i++) w[i] -= lr * (dw[i] / n + l2 * w[i]);
    b -= lr * db / n;
  }

  const nAi   = y.filter(v => v === 1).length;
  const nReal = n - nAi;

  return { weights: w, bias: b, means, stds, trainedAt: Date.now(), nAi, nReal };
}

/**
 * Return P(AI) in [0, 1] for a single feature vector.
 *
 * @param {number[]|Float32Array} features
 * @param {object} model  — result of trainLR()
 * @returns {number}
 */
function predictLR(features, model) {
  const { weights, bias, means, stds } = model;
  let z = bias;
  for (let i = 0; i < weights.length; i++) {
    z += weights[i] * (features[i] - means[i]) / stds[i];
  }
  return 1 / (1 + Math.exp(-z));
}
