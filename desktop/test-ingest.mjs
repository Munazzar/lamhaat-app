// Run: node --no-warnings desktop/test-ingest.mjs
// Edge cases for importing: a corrupt file, a deleted photo, a video, a nested folder, a changed file.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
const { importFolder, listPhotos } = await import('./ingest.js');
const { db } = await import('./db.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-test-'));
// three made-up photos, each different
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-src-'));
const jpgs = [];
for (const [i, rgb] of [[255, 80, 40], [40, 160, 255], [90, 200, 90]].entries()) {
  const f = path.join(src, `${i}.jpg`);
  await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).composite([{ input: Buffer.from(`<svg width="640" height="480"><circle cx="${150 + i * 170}" cy="240" r="90" fill="white"/></svg>`) }]).jpeg().toFile(f);
  jpgs.push(f);
}
fs.mkdirSync(path.join(dir, 'day 2'));
fs.copyFileSync(jpgs[0], path.join(dir, 'a.jpg'));
fs.copyFileSync(jpgs[1], path.join(dir, 'b.jpg'));
fs.copyFileSync(jpgs[2], path.join(dir, 'day 2', 'c.jpg'));
fs.writeFileSync(path.join(dir, 'broken.jpg'), 'not really a jpeg');
fs.writeFileSync(path.join(dir, 'clip.mp4'), 'video');
const folder = path.resolve(dir);

const r1 = await importFolder(folder);
console.log('first', { total: r1.total, added: r1.added, errors: r1.errors.map(e => e.file), skipped: r1.skipped });
assert.equal(r1.total, 4);                 // 3 photos + the broken one; the video is not a photo
assert.equal(r1.added, 3);                 // nested folder included
assert.deepEqual(r1.errors.map(e => e.file), ['broken.jpg']);
assert.equal(r1.skipped, 1);               // the video is noted

db.prepare("UPDATE photos SET decision = 'keep' WHERE path = ?").run(path.join(folder, 'a.jpg'));
fs.rmSync(path.join(dir, 'b.jpg'));
fs.copyFileSync(jpgs[2], path.join(dir, 'a.jpg')); // a.jpg replaced by different content
const r2 = await importFolder(folder);
console.log('second', { added: r2.added, updated: r2.updated, unchanged: r2.unchanged, removed: r2.removed });
assert.equal(r2.removed, 1);
assert.equal(r2.updated, 1);
assert.equal(r2.unchanged, 1);
const a = db.prepare('SELECT decision FROM photos WHERE path = ?').get(path.join(folder, 'a.jpg'));
assert.equal(a.decision, 'keep');          // a decision survives a re-import

db.prepare('DELETE FROM folders WHERE path = ?').run(folder); // clean up (photos cascade)
assert.equal(db.prepare('SELECT count(*) n FROM photos WHERE folder = ?').get(folder).n, 0);
fs.rmSync(dir, { recursive: true });
fs.rmSync(src, { recursive: true });
console.log('ok');
