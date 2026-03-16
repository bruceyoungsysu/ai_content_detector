// features.js — 30-feature image vector for thumbnail classification.
// Loaded in offscreen.html before offscreen.js.
// Pure JS — no dependencies, no model files.
//
// Input:  Uint8ClampedArray from OffscreenCanvas.getImageData() at CANVAS_SIZE×CANVAS_SIZE
// Output: Float32Array[30]
//
// Feature groups:
//   [0-4]   Saturation stats    (mean sat, std sat, hyper-sat fraction, mean L, std L)
//   [5-10]  Color histogram     (R/G/B/hue entropy, top-2 hue concentration, top-1 hue)
//   [11-14] Edge density        (edge fraction, mean gradient, std gradient, spatial uniformity)
//   [15-19] Texture             (local variance, hi-freq ratio, block artifacts, over-sharpening, chrom. aberration)
//   [20-24] Face/text           (skin fraction, bright fraction, dark fraction, center weight, near-white fraction)
//   [25-29] Global              (mean R, mean G, mean B, color temp proxy, luminance variance)

const CANVAS_SIZE = 112; // pixels — balances speed vs. texture detail
const FEAT_SIZE   = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** RGB [0,1] → [H [0,1], S [0,1], L [0,1]] */
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if      (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  return [h / 6, s, l];
}

/** Shannon entropy of a Float32Array of values in [0,1], normalised to [0,1]. */
function entropy(values, n, buckets = 32) {
  const hist = new Float32Array(buckets);
  for (let i = 0; i < n; i++) {
    hist[Math.min(Math.floor(values[i] * buckets), buckets - 1)]++;
  }
  let e = 0;
  for (let i = 0; i < buckets; i++) {
    const p = hist[i] / n;
    if (p > 0) e -= p * Math.log2(p);
  }
  return e / Math.log2(buckets); // [0,1]
}

/** Sobel gradient magnitude array, same size as input. Border pixels = 0. */
function sobelMagnitude(gray, w, h) {
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -gray[(y-1)*w+(x-1)] + gray[(y-1)*w+(x+1)]
        -2*gray[y*w+(x-1)]   + 2*gray[y*w+(x+1)]
        -gray[(y+1)*w+(x-1)] + gray[(y+1)*w+(x+1)];
      const gy =
        -gray[(y-1)*w+(x-1)] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+(x+1)]
        +gray[(y+1)*w+(x-1)] + 2*gray[(y+1)*w+x] + gray[(y+1)*w+(x+1)];
      mag[y*w+x] = Math.sqrt(gx*gx + gy*gy);
    }
  }
  return mag;
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

/**
 * Compute the 30-element feature vector from raw canvas pixel data.
 * @param {Uint8ClampedArray} data - RGBA, length = w * h * 4
 * @param {number} w
 * @param {number} h
 * @returns {Float32Array} length FEAT_SIZE
 */
function computeFeatureVector(data, w, h) {
  const n    = w * h;
  const feat = new Float32Array(FEAT_SIZE);

  // Allocate per-pixel channel arrays
  const rArr  = new Float32Array(n);
  const gArr  = new Float32Array(n);
  const bArr  = new Float32Array(n);
  const hArr  = new Float32Array(n); // hue
  const sArr  = new Float32Array(n); // saturation
  const lArr  = new Float32Array(n); // lightness
  const gray  = new Float32Array(n); // perceptual luminance

  for (let i = 0; i < n; i++) {
    const r = data[i*4]   / 255;
    const g = data[i*4+1] / 255;
    const b = data[i*4+2] / 255;
    const [h, s, l] = rgbToHsl(r, g, b);
    rArr[i] = r; gArr[i] = g; bArr[i] = b;
    hArr[i] = h; sArr[i] = s; lArr[i] = l;
    gray[i] = 0.299*r + 0.587*g + 0.114*b;
  }

  // ── Group 1: Saturation stats [0-4] ──────────────────────────────────────
  let satSum = 0, litSum = 0, hyperSatN = 0;
  for (let i = 0; i < n; i++) {
    satSum += sArr[i];
    litSum += lArr[i];
    if (sArr[i] > 0.7) hyperSatN++;
  }
  const meanSat = satSum / n;
  const meanLit = litSum / n;
  let satSq = 0, litSq = 0;
  for (let i = 0; i < n; i++) {
    satSq += (sArr[i] - meanSat) ** 2;
    litSq += (lArr[i] - meanLit) ** 2;
  }
  feat[0] = meanSat;
  feat[1] = Math.sqrt(satSq / n);   // std saturation
  feat[2] = hyperSatN / n;          // hyper-saturated pixel fraction
  feat[3] = meanLit;
  feat[4] = Math.sqrt(litSq / n);   // std lightness

  // ── Group 2: Color histogram [5-10] ──────────────────────────────────────
  feat[5]  = entropy(rArr, n);
  feat[6]  = entropy(gArr, n);
  feat[7]  = entropy(bArr, n);
  feat[8]  = entropy(hArr, n);

  // Top-2 and top-1 hue bucket concentration (32 hue buckets)
  const hueHist = new Float32Array(32);
  for (let i = 0; i < n; i++) hueHist[Math.min(Math.floor(hArr[i] * 32), 31)]++;
  const hueSorted = Float32Array.from(hueHist).sort().reverse();
  feat[9]  = (hueSorted[0] + hueSorted[1]) / n; // top-2 hue concentration
  feat[10] = hueSorted[0] / n;                  // top-1 hue concentration

  // ── Group 3: Edge density [11-14] ────────────────────────────────────────
  const EDGE_T = 0.05;
  const mag = sobelMagnitude(gray, w, h);
  let edgeN = 0, magSum = 0, magSq = 0;
  for (let i = 0; i < n; i++) {
    if (mag[i] > EDGE_T) edgeN++;
    magSum += mag[i];
    magSq  += mag[i] * mag[i];
  }
  const meanMag = magSum / n;
  feat[11] = edgeN / n;
  feat[12] = meanMag;
  feat[13] = Math.sqrt(Math.max(0, magSq / n - meanMag * meanMag)); // std gradient

  // Spatial uniformity: std of edge fraction across 4 quadrants
  const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
  const qEdge = [0, 0, 0, 0];
  const qN    = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = (y >= hh ? 2 : 0) + (x >= hw ? 1 : 0);
      qN[q]++;
      if (mag[y*w+x] > EDGE_T) qEdge[q]++;
    }
  }
  const qFrac = qEdge.map((e, i) => e / (qN[i] || 1));
  const qMean = (qFrac[0]+qFrac[1]+qFrac[2]+qFrac[3]) / 4;
  const qVar  = qFrac.reduce((s, f) => s + (f - qMean)**2, 0) / 4;
  feat[14] = Math.sqrt(qVar); // low = uniform edge distribution

  // ── Group 4: Texture [15-19] ─────────────────────────────────────────────
  // Local variance: mean of per-pixel 3×3 neighborhood variance
  let localVarSum = 0, patchN = 0;
  for (let y = 1; y < h-1; y++) {
    for (let x = 1; x < w-1; x++) {
      let psum = 0, psq = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = gray[(y+dy)*w+(x+dx)];
          psum += v; psq += v*v;
        }
      }
      const pm = psum / 9;
      localVarSum += psq/9 - pm*pm;
      patchN++;
    }
  }
  feat[15] = localVarSum / patchN;  // low = smooth (AI-like)

  // High-freq power ratio: local variance relative to global lightness variance
  const globalVar = litSq / n;
  feat[16] = globalVar > 1e-9 ? (localVarSum / patchN) / globalVar : 0;

  // Block artifact score: mean discontinuity at 8×8 JPEG-style boundaries
  let blockDiff = 0, blockEdges = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 8; x < w; x += 8) {
      blockDiff += Math.abs(gray[y*w+x] - gray[y*w+x-1]);
      blockEdges++;
    }
  }
  for (let y = 8; y < h; y += 8) {
    for (let x = 0; x < w; x++) {
      blockDiff += Math.abs(gray[y*w+x] - gray[(y-1)*w+x]);
      blockEdges++;
    }
  }
  feat[17] = blockEdges > 0 ? blockDiff / blockEdges : 0;

  // Over-sharpening: high local variance relative to gradient (halo artifact)
  feat[18] = meanMag > 1e-9 ? (localVarSum / patchN) / meanMag : 0;

  // Chromatic aberration proxy: mean |R-B| in edge regions
  let caSum = 0, caN = 0;
  for (let i = 0; i < n; i++) {
    if (mag[i] > EDGE_T) { caSum += Math.abs(rArr[i] - bArr[i]); caN++; }
  }
  feat[19] = caN > 0 ? caSum / caN : 0;

  // ── Group 5: Face / text regions [20-24] ─────────────────────────────────
  let skinN = 0, brightN = 0, darkN = 0, centerSum = 0, centerN = 0, nearWhiteN = 0;
  const cx1 = Math.floor(w * 0.3), cx2 = Math.floor(w * 0.7);
  const cy1 = Math.floor(h * 0.3), cy2 = Math.floor(h * 0.7);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y*w+x;
      const r = rArr[i], g = gArr[i], b = bArr[i];
      const s = sArr[i], l = lArr[i];
      // Skin: reddish, r > g > b, moderate sat and lightness
      if (r > 0.5 && r > g && g > b && s > 0.1 && s < 0.7 && l > 0.2 && l < 0.8) skinN++;
      if (l > 0.85)               brightN++;
      if (l < 0.10)               darkN++;
      if (x >= cx1 && x < cx2 && y >= cy1 && y < cy2) { centerSum += l; centerN++; }
      if (s < 0.1 && l > 0.75)   nearWhiteN++;
    }
  }
  feat[20] = skinN / n;
  feat[21] = brightN / n;
  feat[22] = darkN / n;
  feat[23] = centerN > 0 ? (centerSum / centerN) / (meanLit + 1e-9) : 1; // center brightness ratio
  feat[24] = nearWhiteN / n;

  // ── Group 6: Global [25-29] ───────────────────────────────────────────────
  let rSum = 0, gSum = 0, bSum = 0;
  for (let i = 0; i < n; i++) { rSum += rArr[i]; gSum += gArr[i]; bSum += bArr[i]; }
  feat[25] = rSum / n;
  feat[26] = gSum / n;
  feat[27] = bSum / n;
  feat[28] = (rSum - bSum) / n;  // color temperature: positive = warm, negative = cool
  feat[29] = globalVar;           // luminance variance

  return feat;
}
