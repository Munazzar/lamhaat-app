// Run: node --no-warnings desktop/test-upscale.mjs
// Enhancing a photo without the AI (the careful resize): a new file in the shoot's Enhanced folder, the
// size asked for, with the original's date and camera, the original untouched.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import exifr from 'exifr';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-up-'));
process.env.LAMHAAT_DATA = path.join(tmp, 'data');
const up = await import('./upscale.js');

const folder = path.join(tmp, 'shoot'), file = path.join(folder, 'IMG_1.jpg');
fs.mkdirSync(folder);
await sharp({ create: { width: 600, height: 400, channels: 3, background: '#468' } }).jpeg().toFile(file);
const before = fs.readFileSync(file);
const photo = { path: file, name: 'IMG_1.jpg', folder, w: 600, h: 400, taken: new Date(2026, 4, 1, 9, 30, 0).toISOString(), camera: 'FUJIFILM X-T5' };

assert.deepEqual(up.target(600, 400, 'x4'), { w: 2400, h: 1600 });
assert.deepEqual(up.target(6000, 4000, 'x4'), { w: 13416, h: 8944 }, 'at most 120 megapixels');
assert.deepEqual(up.target(6000, 4000, 'fix'), { w: 6000, h: 4000 }, 'sharpen keeps the size');

const r = await up.enhance(photo, 'x2', { ai: false });
assert.equal(r.file, path.join(folder, 'Enhanced', 'IMG_1 (2x).jpg'));
const m = await sharp(r.file).metadata();
assert.deepEqual([m.width, m.height], [1200, 800]);
const ex = await exifr.parse(r.file);
assert.equal(ex.DateTimeOriginal.getTime(), new Date(photo.taken).getTime(), 'the date carries over');
assert.equal(ex.Make, 'FUJIFILM'); assert.equal(ex.Model, 'X-T5');
assert.deepEqual(fs.readFileSync(file), before, 'the original is untouched');
assert.equal(up.status().ai, false);

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
console.log('ok');
