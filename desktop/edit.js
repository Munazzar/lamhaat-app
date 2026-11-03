// Photo edits: one set of numbers, applied the same way on screen (the window draws them) and when
// publishing (the server draws them), so what you see is what gets published. Originals are never
// changed. Pure JS, no Node or browser APIs, so the Android app can reuse it.
//
// Light and colour sliders run -100..100 (0 = unchanged). Geometry: flips, quarter turns, a small
// straighten angle (the picture zooms in just enough to hide the corners), then a crop given as
// fractions of what is left, so it doesn't depend on image size.

export const SLIDERS = [
  ['exposure', 'Exposure'], ['contrast', 'Contrast'], ['highlights', 'Highlights'], ['shadows', 'Shadows'],
  ['whites', 'Whites'], ['blacks', 'Blacks'], ['saturation', 'Saturation'], ['vibrance', 'Vibrance'],
  ['warmth', 'Warmth'], ['tint', 'Tint'], ['sharpen', 'Sharpen', 0, 100], ['vignette', 'Vignette'],
];
export const NONE = { flipH: false, flipV: false, turn: 0, straighten: 0, crop: null, bw: false, ...Object.fromEntries(SLIDERS.map(([k]) => [k, 0])) };

// a stored edit, made safe: unknown keys dropped, numbers clamped; null when nothing is changed
export function tidy(e) {
  if (!e || typeof e !== 'object') return null;
  const n = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  const out = { ...NONE };
  for (const [k, , lo = -100, hi = 100] of SLIDERS) out[k] = Math.round(n(e[k], lo, hi));
  out.flipH = e.flipH === true; out.flipV = e.flipV === true; out.bw = e.bw === true;
  out.turn = [0, 90, 180, 270].includes(e.turn) ? e.turn : 0;
  out.straighten = Math.round(n(e.straighten, -45, 45) * 10) / 10;
  const c = e.crop;
  if (c && [c.x, c.y, c.w, c.h].every(Number.isFinite)) {
    const x = n(c.x, 0, 1), y = n(c.y, 0, 1), w = n(c.w, 0.02, 1 - x), h = n(c.h, 0.02, 1 - y);
    out.crop = x === 0 && y === 0 && w === 1 && h === 1 ? null : { x, y, w, h };
  }
  return Object.entries(out).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(NONE[k])) ? out : null;
}

// where the picture sits after turning and straightening: the size of the frame before cropping,
// how much straightening zooms in, and the crop in pixels of that frame
export function frame(e, w, h) {
  const turned = e.turn === 90 || e.turn === 270;
  const W = turned ? h : w, H = turned ? w : h;
  const a = Math.abs(e.straighten) * Math.PI / 180;
  const zoom = Math.max((W * Math.cos(a) + H * Math.sin(a)) / W, (W * Math.sin(a) + H * Math.cos(a)) / H);
  const fw = W / zoom, fh = H / zoom; // the straightened picture, corners hidden, in source pixels
  const c = e.crop || { x: 0, y: 0, w: 1, h: 1 };
  return { W, H, zoom, fw, fh, crop: { x: c.x * fw, y: c.y * fh, w: c.w * fw, h: c.h * fh } };
}

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// the light sliders as one curve, 0..255 -> 0..255
export function toneCurve(e) {
  const lut = new Uint8ClampedArray(256);
  const ex = 2 ** (e.exposure / 50), ct = 1 + e.contrast / 100;
  for (let i = 0; i < 256; i++) {
    let v = i / 255 * ex;
    v = (v - 0.5) * ct + 0.5;
    v += (e.highlights / 100) * 0.25 * smooth(0.45, 1, v);
    v += (e.shadows / 100) * 0.25 * (1 - smooth(0, 0.55, v));
    v += (e.whites / 100) * 0.15 * Math.max(0, v) ** 3;
    v += (e.blacks / 100) * 0.15 * Math.max(0, 1 - v) ** 3;
    lut[i] = Math.round(v * 255);
  }
  return lut;
}

// light, colour, black and white, vignette and sharpening, on RGB or RGBA pixels in place
export function applyPixels(px, w, h, ch, e) {
  const lut = toneCurve(e);
  const sat = 1 + e.saturation / 100, vib = e.vibrance / 100;
  const rMul = 1 + e.warmth / 100 * 0.15, bMul = 1 - e.warmth / 100 * 0.15, gMul = 1 - e.tint / 100 * 0.12;
  const vig = e.vignette / 100 * 0.6, cx = w / 2, cy = h / 2, rad = Math.hypot(cx, cy);
  const sharpen = e.sharpen / 100 * 1.2;
  const src = sharpen ? new Uint8ClampedArray(px) : null;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += ch) {
    let r = px[i], g = px[i + 1], b = px[i + 2];
    if (sharpen && x > 0 && y > 0 && x < w - 1 && y < h - 1) { // unsharp mask over the 4 neighbours
      const s = w * ch, k = c => src[i + c] + sharpen * (4 * src[i + c] - src[i + c - ch] - src[i + c + ch] - src[i + c - s] - src[i + c + s]) / 4;
      r = k(0); g = k(1); b = k(2);
    }
    r = lut[Math.max(0, Math.min(255, Math.round(r)))] * rMul; g = lut[Math.max(0, Math.min(255, Math.round(g)))] * gMul; b = lut[Math.max(0, Math.min(255, Math.round(b)))] * bMul;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let m = sat;
    if (vib) { const s = (Math.max(r, g, b) - Math.min(r, g, b)) / 255; m *= 1 + vib * (1 - s); } // lifts dull colours more
    if (e.bw) m = 0;
    r = L + (r - L) * m; g = L + (g - L) * m; b = L + (b - L) * m;
    if (vig) { const f = 1 - vig * smooth(0.45, 1.15, Math.hypot(x - cx, y - cy) / rad); r *= f; g *= f; b *= f; }
    px[i] = r; px[i + 1] = g; px[i + 2] = b; // a Uint8ClampedArray rounds and clamps
  }
  return px;
}
