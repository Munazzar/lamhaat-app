// Run: node --no-warnings desktop/test-publish.mjs
// The publishing agent end to end, against a stand-in GitHub on this PC (desktop/fake-github.mjs):
// generated photos, a private (encrypted) album with titles, people, tags and an edit, then a public
// one that goes on the site; re-running changes nothing; a repository made public by mistake is caught.
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-pub-'));
process.env.LAMHAAT_DATA = path.join(tmp, 'data');
process.env.LAMHAAT_PUSH_GAP_MS = '0';
const { fakeGitHub } = await import('./fake-github.mjs');
const gh = await fakeGitHub(path.join(tmp, 'github'));
const { db } = await import('./db.js');
const { importFolder } = await import('./ingest.js');
const meta = await import('./meta.js');
const { saveSecret } = await import('./secrets.js');
const { publish } = await import('./publish.js');
const { loadKeys } = await import('../scripts/keys.js');

// two shoots of generated photos: coloured gradients, 1200 x 800
async function shoot(name, n) {
  const dir = path.join(tmp, 'photos', name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const raw = Buffer.alloc(1200 * 800 * 3);
    for (let y = 0; y < 800; y++) for (let x = 0; x < 1200; x++) { const k = (y * 1200 + x) * 3; raw[k] = (x / 5 + i * 40) % 256; raw[k + 1] = y / 4; raw[k + 2] = 90 + i * 30; }
    await sharp(raw, { raw: { width: 1200, height: 800, channels: 3 } }).jpeg({ quality: 90 }).toFile(path.join(dir, `IMG_${i + 1}.jpg`));
  }
  await importFolder(dir, () => {});
  db.prepare("UPDATE photos SET decision = 'keep' WHERE folder = ?").run(dir);
  return { dir, ids: db.prepare('SELECT id FROM photos WHERE folder = ? ORDER BY name').all(dir).map(r => r.id) };
}
const priv = await shoot('family day', 4), pub = await shoot('garden walk', 2);

// what was added in the app
meta.setText(priv.ids[0], { title: 'Ayesha laughing', description: 'In the garden, just before the rain.' });
meta.tagPhotos([priv.ids[0], priv.ids[1]], { name: 'Ayesha', kind: 'person' });
meta.tagPhotos([priv.ids[2]], { name: 'garden' });
meta.setEdits(priv.ids[1], { crop: { x: 0.25, y: 0, w: 0.5, h: 0.75 }, exposure: 20 }); // a square crop of a 3:2 photo
const saveAlbum = (dir, a) => db.prepare('INSERT INTO albums (folder, data) VALUES (?, ?) ON CONFLICT(folder) DO UPDATE SET data = excluded.data').run(dir, JSON.stringify(a));
saveAlbum(priv.dir, { title: 'Family Day', description: 'A Sunday together.', groupBy: 'person', sort: 'taken', chapters: [{ start: null, title: '', sub: '' }], highlights: [priv.ids[0]], public: false });
saveSecret('github', JSON.stringify({ token: 'test-token', host: gh.host, method: 'token', login: 'tester' }));

// 1. a private album: encrypted, never on the site
let run = await publish(priv.dir);
assert.equal(run.status, 'done', JSON.stringify(run.error));
assert.equal(run.steps.find(s => s.id === 'site').status, 'skipped', 'private albums leave the site alone');
const id = JSON.parse(db.prepare('SELECT data FROM albums WHERE folder = ?').get(priv.dir).data).id;
const media = `lamha-a-${id}-media`;
assert.deepEqual(gh.counts.created.sort(), [`lamha-a-${id}`, media, 'lamha-catalog', 'lamha-full-1'].sort());
assert.ok(!gh.repos.get('lamha-full-1').private, 'full-size copies are in a public repository of their own (a Pages site)');
assert.ok(gh.repos.get(media).private && gh.repos.get('lamha-catalog').private && !gh.repos.get(`lamha-a-${id}`).private);
const keys = loadKeys();
const { albumKey } = await import('./firebase.js');
assert.throws(() => { const d = crypto.createDecipheriv('aes-256-gcm', keys.enc, gh.show(media, 'manifest.json').subarray(0, 12)); d.setAuthTag(gh.show(media, 'manifest.json').subarray(-16)); d.update(gh.show(media, 'manifest.json').subarray(12, -16)); d.final(); }, 'the library key itself opens nothing: each album has its own');
const open = buf => { const d = crypto.createDecipheriv('aes-256-gcm', albumKey(keys, id), buf.subarray(0, 12)); d.setAuthTag(buf.subarray(-16)); return Buffer.concat([d.update(buf.subarray(12, -16)), d.final()]); };
const raw = gh.show(media, 'manifest.json');
assert.throws(() => JSON.parse(raw.toString()), 'the manifest on GitHub is unreadable without the key');
const m = JSON.parse(open(raw).toString());
assert.equal(m.title, 'Family Day'); assert.equal(m.description, 'A Sunday together.');
assert.deepEqual(m.chapters.map(c => c.title), ['Ayesha', 'Everyone else']);
const byName = Object.fromEntries(m.photos.map(p => [p.src, p]));
assert.equal(byName.IMG_1.title, 'Ayesha laughing'); assert.equal(byName.IMG_1.desc, 'In the garden, just before the rain.');
assert.deepEqual(byName.IMG_1.people, ['Ayesha']); assert.deepEqual(byName.IMG_3.tags, ['garden']);
assert.equal(byName.IMG_1.c, 0); assert.equal(byName.IMG_3.c, 1);
assert.deepEqual(m.photos.map(p => p.n).sort(), [0, 1, 2, 3]);
assert.deepEqual(m.highlights, ['IMG_1']);
assert.ok(byName.IMG_2.e && !byName.IMG_1.e, 'the edited photo is marked');
assert.equal(byName.IMG_2.w, byName.IMG_2.hgt, 'its size is the cropped one');
const full = await sharp(open(gh.show(media, byName.IMG_2.v.full.path))).metadata();
assert.equal(full.width, full.height, 'the published copy carries the crop');
assert.ok(!(await sharp(open(gh.show(media, byName.IMG_1.v.full.path))).metadata()).exif, 'no camera data in published copies');
// full size for the large view: the photo at its own size, sealed like the rest, without camera data
const orig = byName.IMG_1.v.orig;
assert.equal(orig.site, 'lamha-full-1'); assert.ok(orig.sealed);
const big = await sharp(open(gh.show('lamha-full-1', orig.path))).metadata();
assert.deepEqual([big.format, big.width, big.height], ['jpeg', 1200, 800], 'the full size, not a smaller copy');
assert.ok(!big.exif, 'no camera data (no GPS) in the full-size copy either');
assert.equal((await sharp(open(gh.show('lamha-full-1', byName.IMG_2.v.orig.path))).metadata()).width, 600, 'with its edits: the crop');
const cat = JSON.parse(gh.show('lamha-catalog', 'catalog.json'));
assert.equal(cat.albums.length, 1); assert.equal(cat.albums[0].encrypted, true); assert.equal(cat.albums[0].public, false);

// 2. again: nothing changes on GitHub
const pushes = gh.counts.pushes;
run = await publish(priv.dir);
assert.equal(run.status, 'done');
assert.equal(gh.counts.pushes, pushes, 'a second run pushes nothing');

// 3. an edit changed: only that photo is made again
meta.setEdits(priv.ids[1], { bw: true });
run = await publish(priv.dir);
assert.match(run.steps.find(s => s.id === 'copies').detail, /^1 new photo/);
assert.equal(JSON.parse(open(gh.show(media, 'manifest.json')).toString()).photos.find(p => p.src === 'IMG_2').w, 1200, 'crop gone, full width back');

// 4. a public album: unencrypted, on the site, checked live
saveAlbum(pub.dir, { title: 'Garden Walk', groupBy: 'date', chapters: [{ start: null, title: '', sub: '' }], highlights: [], public: true });
run = await publish(pub.dir);
assert.equal(run.status, 'done', JSON.stringify(run.error));
assert.ok(run.url.includes('/pages/tester/lamhaat/'));
const site = JSON.parse(gh.show('lamhaat', 'media/lamha-catalog/catalog.json'));
assert.deepEqual(site.albums.map(a => a.title), ['Garden Walk'], 'only public albums on the site');
assert.ok(!('groups' in site.albums[0]), 'who-can-see lists stay private');
assert.ok(gh.show('lamhaat', 'index.html') && gh.show('lamhaat', '.nojekyll') != null);

// 4b. a big album spans repositories: once one is full, new copies go to -part2, and the site finds them there
const wide = await shoot('big walk', 3);
saveAlbum(wide.dir, { title: 'Big Walk', groupBy: 'date', chapters: [{ start: null, title: '', sub: '' }], highlights: [], public: true, full: false });
process.env.LAMHAAT_ROLL_BYTES = '8000'; // a few copies a repository (these test photos are tiny)
run = await publish(wide.dir);
delete process.env.LAMHAAT_ROLL_BYTES;
assert.equal(run.status, 'done', JSON.stringify(run.error));
const bigId = JSON.parse(db.prepare('SELECT data FROM albums WHERE folder = ?').get(wide.dir).data).id;
const bigM = JSON.parse(gh.show(`lamha-a-${bigId}-media`, 'manifest.json'));
const used = [...new Set(bigM.photos.flatMap(p => Object.values(p.v).map(v => v.repo)))];
assert.ok(used.length >= 2 && used.includes(`lamha-a-${bigId}-media-part2`), `copies spread over ${used.join(', ')}`);
assert.ok(gh.repos.get(`lamha-a-${bigId}-media-part2`).private, 'a part is private too');
for (const p of bigM.photos) for (const v of Object.values(p.v)) {
  assert.ok(gh.show(v.repo, v.path), `${v.path} is in ${v.repo}`);
  assert.ok(gh.show('lamhaat', `media/${v.repo}/${v.path}`), 'and on the site, under the repository it lives in');
}
assert.deepEqual(JSON.parse(gh.show('lamhaat', 'media/lamha-catalog/catalog.json')).albums.find(a => a.id === bigId).repos.sort(), used.sort(), 'the catalog lists every part');

// 4c. a photo taken out, then removed for good: gone from the album's repositories and the site, history let go
const { purgeAlbum } = await import('./publish.js');
const outId = wide.ids[0];
db.prepare("UPDATE photos SET decision = 'reject' WHERE id = ?").run(outId);
assert.equal((await publish(wide.dir)).status, 'done');
const outV = bigM.photos.find(p => !JSON.parse(gh.show(`lamha-a-${bigId}-media`, 'manifest.json')).photos.some(q => q.h === p.h)).v;
assert.ok(gh.show(outV.md.repo, outV.md.path), 'taken out of the list, its files are still kept by git');
const r4 = await purgeAlbum(wide.dir);
assert.ok(r4.removed > 0);
for (const v of Object.values(outV)) {
  assert.equal(gh.show(v.repo, v.path), null, `${v.path} is gone from ${v.repo}`);
  assert.equal(gh.show('lamhaat', `media/${v.repo}/${v.path}`), null, 'and from the site');
}
assert.equal(gh.commits(`lamha-a-${bigId}-media`), 1, 'its history starts again from now');
const left = JSON.parse(gh.show(`lamha-a-${bigId}-media`, 'manifest.json'));
for (const p of left.photos) for (const v of Object.values(p.v)) assert.ok(gh.show('lamhaat', `media/${v.repo}/${v.path}`), 'what is still listed stays');
assert.ok(gh.show('lamhaat', 'media/lamha-catalog/catalog.json'), 'the rest of the site is untouched');

// 5. a private repository made public by mistake is caught, not uploaded to
gh.repos.get(media).private = false;
run = await publish(priv.dir);
assert.equal(run.status, 'failed'); assert.equal(run.error.kind, 'public-repo'); assert.equal(run.error.repo, media);

// 6. signed out: stops at the first step with a plain message
fs.rmSync(path.join(process.env.LAMHAAT_DATA, 'secrets'), { recursive: true });
run = await publish(pub.dir);
assert.equal(run.error.kind, 'signin');

// search by meaning: numbers packed the way the site packs them are kept (384 bytes = 512 characters)
{
  const { pack, DIMS } = await import('../site/meaning.js');
  const embeds = await import('./embeds.js');
  const vec = pack(new Float32Array(DIMS).map((_, i) => Math.sin(i)));
  assert.equal(vec.length, 512);
  const id = db.prepare('SELECT id FROM photos LIMIT 1').get().id;
  assert.equal(embeds.save([{ id, hash: '0123456789abcdef', vec }]), 1, 'a real packed vector is saved');
  assert.equal(embeds.save([{ id, hash: '0123456789abcdef', vec: vec.slice(2) + '==' }]), 0, 'a damaged one is not');
  console.log('ok: search-by-meaning numbers are kept');
}

await gh.close();
db.close();
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {} // Windows can hold a temp file a moment longer; it is only scratch space
console.log('ok');

