// Run: node desktop/test-score.mjs
// Checks the scores on generated pictures whose answers are known.
import assert from 'node:assert';
import { scoreGrey, flagShoot } from './score.js';

const W = 512, H = 384;
const make = f => { const g = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = f(x, y); return g; };
// a detailed scene: random blocks of texture
const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
const base = make(() => 40 + rnd() * 170);
const boxBlur = (g, rx, ry) => { // rx, ry: horizontal / vertical radius
  const o = new Uint8Array(g.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) {
      const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy)); s += g[yy * W + xx]; n++;
    }
    o[y * W + x] = s / n;
  }
  return o;
};

const sharp = scoreGrey(base, W, H);
const soft = scoreGrey(boxBlur(base, 3, 3), W, H);       // missed focus: soft in every direction
const shake = scoreGrey(boxBlur(base, 7, 0), W, H);      // camera moved sideways: smeared one way
// a sharp subject in one corner, the rest soft (bokeh): judged by the subject, so still sharp
const bokehG = boxBlur(base, 4, 4); for (let y = 0; y < 96; y++) for (let x = 0; x < 128; x++) bokehG[y * W + x] = base[y * W + x];
const bokeh = scoreGrey(bokehG, W, H);
const blown = scoreGrey(make((x, y) => (x < W * 0.3 ? 255 : 120)), W, H);
const dark = scoreGrey(make((x, y) => (y < H / 2 ? 0 : 120)), W, H);

console.table({ sharp, soft, shake, bokeh, blown, dark });
assert(sharp.sharpness > soft.sharpness * 5, 'blurring lowers sharpness a lot');
assert(bokeh.sharpness > sharp.sharpness * 0.8, 'a sharp subject keeps a photo sharp despite a soft background');
assert(shake.coherence > 0.55 && soft.coherence < 0.3, 'shake is directional, missed focus is not');
assert(blown.highs > 0.2 && blown.lows === 0, 'blown highlights are measured');
assert(dark.lows > 0.45, 'crushed shadows are measured');
const bright = scoreGrey(make((x, y) => (x < W * 0.1 ? 255 : 120)), W, H); // a little bright sky is fine

// flags, judged within a shoot of 20 sharp photos plus the problem ones
const shoot = [...Array(20).fill(sharp), soft, shake, bokeh, blown, dark, bright];
const flags = flagShoot(shoot);
assert.deepEqual(flags[0], []);
assert.deepEqual(flags[20], ['blurry']);
assert.deepEqual(flags[21], ['motion']);
assert.deepEqual(flags[22], []);
assert(flags[23].includes('highlights'));
assert(flags[24].includes('shadows'));
assert(!flags[25].includes('highlights'), '10% white sky is not flagged');
// a shoot where everything is equally sharp flags nothing, even though someone has to be in the "bottom 15%"
assert(flagShoot(Array(30).fill(sharp)).every(f => f.length === 0));
console.log('ok');
