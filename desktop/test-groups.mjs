// Run: node desktop/test-groups.mjs
// Fingerprints and grouping on generated pictures with known answers.
import assert from 'node:assert';
import { signature } from './score.js';
import { groupShoot, hamming, correlation } from './groups.js';

const W = 320, H = 240;
const scene = seed => { // a smooth random landscape, different per seed
  let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const blobs = Array.from({ length: 12 }, () => [r() * W, r() * H, 20 + r() * 60, r() * 200]);
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 30; for (const [bx, by, br, bv] of blobs) v += bv * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (br * br));
    g[y * W + x] = Math.min(255, v);
  }
  return g;
};
const shift = (g, dx) => { const o = new Uint8Array(g.length); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o[y * W + x] = g[y * W + Math.min(W - 1, Math.max(0, x - dx))]; return o; };
const noise = (g, amt, seed) => { let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647; return g.map(v => Math.max(0, Math.min(255, v + (r() - 0.5) * amt))); };

const A = scene(3), B = scene(99);
const sa = signature(A, W, H), sa2 = signature(noise(A, 6, 5), W, H), sa3 = signature(shift(A, 14), W, H), sb = signature(B, W, H);
console.log('re-saved copy:', hamming(sa.dhash, sa2.dhash), 'bits,', correlation(sa.tiny, sa2.tiny).toFixed(3));
console.log('moved a little:', hamming(sa.dhash, sa3.dhash), 'bits,', correlation(sa.tiny, sa3.tiny).toFixed(3));
console.log('different scene:', hamming(sa.dhash, sb.dhash), 'bits,', correlation(sa.tiny, sb.tiny).toFixed(3));
assert(hamming(sa.dhash, sa2.dhash) <= 6 && correlation(sa.tiny, sa2.tiny) > 0.95, 'a re-saved copy matches closely');
assert(hamming(sa.dhash, sb.dhash) > 20 && correlation(sa.tiny, sb.tiny) < 0.8, 'different scenes do not match');

const t = s => new Date(Date.UTC(2026, 8, 5, 10, 0, 0) + s * 1000).toISOString();
const P = (id, sig, taken, sharpness, extra = {}) => ({ id, name: `IMG_${id}.jpg`, sha256: `f${id}`, rawsha: `r${id}`, taken, sharpness, flags: [], ...sig, ...extra });
const photos = [
  // a burst of 4 frames 0.5 s apart; frame 3 is sharpest but blown out, so frame 2 should be picked
  P(1, sa, t(0), 300), P(2, sa3, t(0.5), 800), P(3, signature(shift(A, 7), W, H), t(1), 1200, { flags: ['highlights'] }), P(4, sa2, t(1.5), 500),
  // the same scene shot again 10 minutes later: near duplicate of the burst, not part of it in time
  P(5, sa2, t(600), 650),
  // an unrelated photo a second later: close in time but different, so not in a burst
  P(6, sb, t(601), 900),
  // an exact copy of 6 (same file contents), and one only identical once decoded
  P(7, sb, t(5000), 900, { sha256: 'f6' }), P(8, sb, t(5001), 900, { rawsha: 'r6' }),
  // one copy deeper in a share folder: the copy at the top level is kept
  P(9, sa, t(9000), 400, { sha256: 'same', rel: 'kids/share/IMG_9.jpg', dhash: '0000000000000000' }), P(10, sa, t(9500), 400, { sha256: 'same', rel: 'kids/IMG_9.jpg', dhash: '0000000000000000' }),
];
const groups = groupShoot(photos);
console.log(groups);
const burst = groups.find(g => g.ids.includes(1));
assert.equal(burst.kind, 'burst');
assert.deepEqual(burst.ids.sort(), [1, 2, 3, 4, 5], 'the later re-shoot joins the burst as a near duplicate');
assert.equal(burst.pick, 2, 'sharpest frame without blown highlights');
assert.match(burst.reason, /1 other has blur or exposure problems/);
const exact = groups.find(g => g.ids.includes(6));
assert.equal(exact.kind, 'exact');
assert.deepEqual(exact.ids.sort(), [6, 7, 8]);
assert.equal(exact.pick, 6);
const copies = groups.find(g => g.ids.includes(9));
assert.equal(copies.pick, 10, 'keep the copy outside the share folder');
assert.match(copies.reason, /keeping kids.IMG_9.jpg, the copy in kids.share.IMG_9.jpg is extra/);
assert(!groups.some(g => g.ids.includes(6) && g.ids.includes(1)), 'different scenes never group');
// a lone photo is in no group
assert.equal(groupShoot([P(1, sa, t(0), 1)]).length, 0);
console.log('ok');
