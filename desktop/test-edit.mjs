// Run: node desktop/test-edit.mjs
// Edits on generated pictures with known answers.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { tidy, frame, toneCurve, applyPixels, NONE } from './edit.js';
import { edited } from './render.js';

// tidy: nothing changed is null, junk is dropped, numbers are clamped
assert.equal(tidy(null), null);
assert.equal(tidy({ ...NONE }), null);
assert.equal(tidy({ exposure: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }), null, 'a full-size crop is no crop');
const t = tidy({ exposure: 500, turn: 45, straighten: 99, bw: 'yes', evil: 1, crop: { x: 0.9, y: 0, w: 0.5, h: 1 } });
assert.equal(t.exposure, 100); assert.equal(t.turn, 0); assert.equal(t.straighten, 45); assert.equal(t.bw, false);
assert.ok(!('evil' in t)); assert.ok(Math.abs(t.crop.w - 0.1) < 1e-9, 'crop kept inside the picture');

// the tone curve: unchanged is identity; exposure up brightens; contrast spreads around the middle
assert.deepEqual([...toneCurve(NONE)], [...Array(256).keys()]);
assert.ok(toneCurve({ ...NONE, exposure: 50 })[100] > 190);
const c = toneCurve({ ...NONE, contrast: 50 });
assert.ok(c[64] < 64 && c[192] > 192 && Math.abs(c[128] - 128) <= 1);
assert.ok(toneCurve({ ...NONE, shadows: 100 })[30] > 40 && toneCurve({ ...NONE, shadows: 100 })[230] <= 231, 'shadows lift darks, leave brights');
assert.ok(toneCurve({ ...NONE, highlights: -100 })[230] < 220 && toneCurve({ ...NONE, highlights: -100 })[20] >= 19, 'highlights pull brights, leave darks');

// colour: black and white has no colour left; warmth makes red stronger than blue
const px = new Uint8ClampedArray([200, 80, 40, 40, 80, 200]);
applyPixels(px, 2, 1, 3, { ...NONE, bw: true });
assert.ok(px[0] === px[1] && px[1] === px[2] && px[3] === px[4]);
const warm = applyPixels(new Uint8ClampedArray([128, 128, 128]), 1, 1, 3, { ...NONE, warmth: 100 });
assert.ok(warm[0] > 128 && warm[2] < 128);

// straightening zooms in just enough; the crop is a fraction of what is left
const f = frame({ ...NONE, straighten: 10, turn: 90, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, 400, 300);
assert.equal(f.W, 300); assert.equal(f.H, 400); assert.ok(f.zoom > 1.2 && f.zoom < 1.4);
assert.ok(Math.abs(f.crop.w - f.fw / 2) < 1e-9);

// on a real file: turn + crop give the expected size; flips land pixels on the other side
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-edit-'));
const file = path.join(dir, 'a.png');
const W = 400, H = 300, raw = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw[(y * W + x) * 3] = x < W / 2 ? 255 : 0; // left half red
await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
const size = async (e, edge = 4000) => (await (await edited(file, e, edge)).png().toBuffer({ resolveWithObject: true })).info;
let i = await size({ turn: 90 }); assert.deepEqual([i.width, i.height], [300, 400]);
i = await size({ crop: { x: 0.25, y: 0, w: 0.5, h: 0.5 } }); assert.deepEqual([i.width, i.height], [200, 150]);
i = await size({ straighten: 5 }); assert.ok(i.width < 400 && i.height < 300 && Math.abs(i.width / i.height - 4 / 3) < 0.02, 'straightened, same shape, no corners');
const left = async e => { const r = await (await edited(file, e, 4000)).raw().toBuffer({ resolveWithObject: true }); return r.data[(150 * r.info.width + 20) * r.info.channels]; };
assert.ok(await left({ exposure: 1 }) > 200, 'left stays red');
assert.ok(await left({ flipH: true }) < 50, 'flipped: red moves right');
i = await size({ exposure: 30 }, 100); assert.equal(i.width, 100, 'size limit kept');
fs.rmSync(dir, { recursive: true, force: true });
console.log('ok');
