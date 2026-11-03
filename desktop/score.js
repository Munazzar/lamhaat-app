// Photo quality scores, computed from a greyscale picture (Uint8 luminance, width x height).
// Pure maths with no Node or Windows APIs, so the same file can run in the Android app.
//
//  sharpness  variance of the Laplacian in the sharpest ~5% of the frame (the subject), not the
//             whole frame, so an intentionally soft background doesn't count against a photo
//  coherence  0..1, how much the detail in that part runs in one direction: high when the
//             camera moved (a smear), low when focus was simply missed
//  highs/lows share of the frame that is pure white / pure black (clipped)

const GRID = 8; // the frame is judged as 8 x 8 tiles

export function scoreGrey(g, w, h) {
  const tw = Math.floor(w / GRID), th = Math.floor(h / GRID);
  const sum = new Float64Array(GRID * GRID), sq = new Float64Array(GRID * GRID), n = new Uint32Array(GRID * GRID);
  let highs = 0, lows = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = g[row + x];
      if (v >= 250) highs++; else if (v <= 5) lows++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) continue;
      const tx = Math.min(GRID - 1, (x / tw) | 0), ty = Math.min(GRID - 1, (y / th) | 0), t = ty * GRID + tx;
      const lap = 4 * v - g[row + x - 1] - g[row + x + 1] - g[row - w + x] - g[row + w + x];
      sum[t] += lap; sq[t] += lap * lap; n[t]++;
    }
  }
  const variance = Array.from(sum, (s, t) => n[t] ? sq[t] / n[t] - (s / n[t]) ** 2 : 0);
  // the subject: the sharpest 3 of 64 tiles (about 5% of the frame), so a small subject such as a
  // bird or a face in a wide shot still decides; 3 rather than 1 so a single noisy tile can't
  const order = variance.map((v, t) => [v, t]).sort((a, b) => b[0] - a[0]);
  const top = order.slice(0, 3);
  const sharpness = top.reduce((s, [v]) => s + v, 0) / top.length;

  // structure tensor over those tiles: how strongly the gradients line up in one direction
  let sxx = 0, syy = 0, sxy = 0;
  for (const [, t] of top) {
    const x0 = Math.max(1, (t % GRID) * tw), y0 = Math.max(1, ((t / GRID) | 0) * th);
    const x1 = Math.min(w - 1, x0 + tw), y1 = Math.min(h - 1, y0 + th);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * w + x, gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w];
      sxx += gx * gx; syy += gy * gy; sxy += gx * gy;
    }
  }
  const tr = sxx + syy, det = Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy);
  const coherence = tr > 0 ? det / tr : 0;
  const all = w * h;
  // focus: where the sharpest tile is, as fractions of the frame (handy for showing what was judged)
  const best = top[0][1];
  return { sharpness, coherence, highs: highs / all, lows: lows / all, focus: [((best % GRID) + 0.5) / GRID, (((best / GRID) | 0) + 0.5) / GRID] };
}

// Flags for one shoot (spec section 4). Thresholds were set by looking at 634 photos of a real shoot at
// 100%: sharpness alone can't tell a sharp smooth subject (skin, fabric) from a slightly soft busy scene,
// so only clearly soft photos are flagged; the rest is for "softest first" and, in bursts, for picking
// the sharpest frame. Deep shadows were mostly style, not mistakes, so only near-black frames are flagged.
export const DEFAULTS = {
  blurVsMedian: 0.06,  // blurry: sharper than only 6% of the shoot's typical photo...
  blurFloor: 100,      // ...or below this whatever the shoot
  motionCoherence: 0.55,
  highlights: 0.25,    // more than a quarter of the frame pure white: a blown sky
  shadows: 0.45,       // nearly half the frame pure black: a dark or black frame
};

export function flagShoot(scores, opts = DEFAULTS) {
  const sharp = scores.map(s => s.sharpness).filter(v => v != null).sort((a, b) => a - b);
  if (!sharp.length) return scores.map(() => []);
  const median = sharp[Math.floor(sharp.length / 2)];
  const cut = Math.max(opts.blurFloor, median * opts.blurVsMedian);
  return scores.map(s => {
    if (s.sharpness == null) return [];
    const flags = [];
    if (s.sharpness < cut) flags.push(s.coherence >= opts.motionCoherence ? 'motion' : 'blurry');
    else if (s.subjectSharp != null && s.subjectSharp < cut) flags.push('subject'); // sharp somewhere, but not where it matters (the AI found the subject)
    if (s.highs > opts.highlights) flags.push('highlights');
    if (s.lows > opts.shadows) flags.push('shadows');
    return flags;
  });
}

// Fingerprints for finding duplicates and bursts (spec section 4): a 64-bit difference hash, and a
// 32 x 32 greyscale thumbnail for a stricter comparison (stands in for CLIP until search is added).
export function signature(g, w, h) {
  const d = shrink(g, w, h, 9, 8);
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (d[y * 9 + x] < d[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return { dhash: hex, tiny: shrink(g, w, h, 32, 32) };
}

// area-average downscale of a greyscale picture
function shrink(g, w, h, W, H) {
  const o = new Uint8Array(W * H);
  for (let Y = 0; Y < H; Y++) {
    const y0 = Math.floor((Y * h) / H), y1 = Math.max(y0 + 1, Math.floor(((Y + 1) * h) / H));
    for (let X = 0; X < W; X++) {
      const x0 = Math.floor((X * w) / W), x1 = Math.max(x0 + 1, Math.floor(((X + 1) * w) / W));
      let s = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += g[y * w + x];
      o[Y * W + X] = Math.round(s / ((y1 - y0) * (x1 - x0)));
    }
  }
  return o;
}
