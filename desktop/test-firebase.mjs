// Run: node --no-warnings desktop/test-firebase.mjs
// Sharing private albums with Google sign-in, on this PC: the owner signs in, a family-only album is
// published to a stand-in GitHub, Firestore (a stand-in acting out the rules) gets its details and key,
// and the people list decides who reads them. The sealed files on the site open with that key, the
// same way the site's service worker does it.
import crypto from 'node:crypto';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-fb-'));
process.env.LAMHAAT_DATA = path.join(tmp, 'data');
process.env.LAMHAAT_PUSH_GAP_MS = '0';
const OWNER = 'owner@example.com';
const { fakeGitHub } = await import('./fake-github.mjs');
const { fakeFirebase } = await import('./fake-firebase.mjs');
const gh = await fakeGitHub(path.join(tmp, 'github'));
const ff = await fakeFirebase({ owner: OWNER });
process.env.LAMHAAT_FIRESTORE = `${ff.base}/v1`;
process.env.LAMHAAT_SECURETOKEN = `${ff.base}/v1`;

const { db, setting } = await import('./db.js');
const { importFolder } = await import('./ingest.js');
const { saveSecret } = await import('./secrets.js');
const { publish } = await import('./publish.js');
const people = await import('./people.js');
const fb = await import('./firebase.js');
const { loadKeys } = await import('../scripts/keys.js');

// the settings block, as pasted; bad ones refused
assert.throws(() => fb.saveDetails({ config: 'hello' }), /firebaseConfig/);
fb.saveDetails({ ownerName: 'Sam', config: 'const firebaseConfig = {\n  apiKey: "AIzaSyTestTestTestTestTestTestTest123",\n  authDomain: "lamhaat-test.firebaseapp.com",\n  projectId: "lamhaat-test",\n  storageBucket: "x",\n  appId: "1:1:web:a"\n};' });
assert.equal(fb.status().ready, false, 'not ready before the owner signs in');
assert.deepEqual(JSON.parse(setting('siteConfig')), { firebase: fb.settings().config, ownerName: 'Sam' }, 'the site learns the Google sign-in settings');

// the owner signs in (the window hands over Google's renewal key)
await assert.rejects(fb.ownerSignIn('wrong'), e => e.kind === 'fbsignin');
const st = await fb.ownerSignIn('owner-refresh');
assert.equal(st.owner, OWNER); assert.equal(st.ready, true);
assert.match(fb.rulesFor(st.owner), /me\(\) == 'owner@example\.com'/, 'the rules name the owner');

// the check: no database yet, rules not pasted, then all good
ff.state.mode = 'nodb'; await assert.rejects(fb.check(), e => e.kind === 'nostore');
ff.state.mode = 'locked'; await assert.rejects(fb.check(), e => e.kind === 'rules' && /owner@example.com/.test(e.message));
ff.state.mode = 'ok'; ff.state.rules = 1;
await assert.rejects(fb.check(), e => e.kind === 'rules' && /older/.test(e.message), 'the older rules are noticed');
ff.state.rules = 2; assert.equal(await fb.check(), true);
assert.equal(fb.status().rulesOld, false);
assert.equal(fb.status().connected, true);
assert.equal(ff.read('albums/_check'), null, 'the test write is cleaned up');

// people and a family-only album
people.savePerson({ email: 'Sister@Example.com', name: 'Sister', groups: ['family'] });
people.savePerson({ email: 'friend@example.com', name: 'Friend', groups: ['friends'] });
const dir = path.join(tmp, 'photos', 'eid');
fs.mkdirSync(dir, { recursive: true });
for (let i = 0; i < 3; i++) await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 40 + i * 60, g: 120, b: 160 } } }).jpeg().toFile(path.join(dir, `E${i}.jpg`));
await importFolder(dir, () => {});
db.prepare("UPDATE photos SET decision = 'keep' WHERE folder = ?").run(dir);
db.prepare('INSERT INTO albums (folder, data) VALUES (?, ?)').run(dir, JSON.stringify({ title: 'Eid', groupBy: 'date', chapters: [{ start: null, title: '', sub: '' }], highlights: [], public: false, groups: ['family'] }));
saveSecret('github', JSON.stringify({ token: 'test', host: gh.host, method: 'token', login: 'tester' }));
const run = await publish(dir);
assert.equal(run.status, 'done', JSON.stringify(run.error));
assert.match(run.steps.find(s => s.id === 'share').detail, /Shared with family/);
const id = JSON.parse(db.prepare('SELECT data FROM albums WHERE folder = ?').get(dir).data).id;

// what Firestore holds
const doc = ff.read(`albums/${id}`);
assert.equal(doc.title, 'Eid'); assert.deepEqual(doc.groups, ['owner', 'family']);
assert.equal(doc.key, fb.albumKey(loadKeys(), id).toString('base64'), 'the album’s own key');
assert.deepEqual(ff.read('access/sister@example.com').albums, [id], 'family sees it');
assert.deepEqual(ff.read('access/friend@example.com').albums, [], 'friends don’t');
assert.deepEqual(ff.read('access/_everyone').albums, []);

// on the site: sealed files, nothing readable without the key; with it, they open (as sw.js does it)
const media = doc.repos[0];
const sealedManifest = gh.show('lamhaat', `media/${media}/manifest.json`);
assert.ok(sealedManifest, 'the private album is next to the site');
assert.throws(() => JSON.parse(sealedManifest.toString()), 'but sealed');
const site = JSON.parse(gh.show('lamhaat', 'media/lamha-catalog/catalog.json'));
assert.ok(!site.albums.some(a => a.id === id), 'and never in the public list');
const key = await crypto.subtle.importKey('raw', Buffer.from(doc.key, 'base64'), 'AES-GCM', false, ['decrypt']);
const unseal = async buf => Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12)));
const manifest = JSON.parse(await unseal(sealedManifest));
assert.equal(manifest.title, 'Eid'); assert.equal(manifest.photos.length, 3);
const thumb = await unseal(gh.show('lamhaat', `media/${media}/${manifest.photos[0].v.thumb.path}`));
assert.equal((await sharp(thumb).metadata()).format, 'heif', 'a photo opens');
assert.deepEqual(JSON.parse(gh.show('lamhaat', 'config.json')), { firebase: fb.settings().config, ownerName: 'Sam' }, 'the site has the sign-in settings');

// viewers, as the rules allow (the stand-in acts them out)
const as = (email, p) => fetch(`${ff.base}/v1/projects/lamhaat-test/databases/(default)/documents/${p}`, { headers: { authorization: `Bearer ${ff.jwt(email)}` } }).then(r => r.status);
assert.equal(await as('sister@example.com', `albums/${id}`), 200);
assert.equal(await as('friend@example.com', `albums/${id}`), 403);
assert.equal(await as('stranger@example.com', `albums/${id}`), 403);
assert.equal(await as('sister@example.com', 'access/friend@example.com'), 403, 'nobody reads someone else’s list');

// anyone signed in: a group of its own
people.savePerson({ email: 'friend@example.com', name: 'Friend', groups: ['friends'] });
db.prepare('UPDATE albums SET data = ? WHERE folder = ?').run(JSON.stringify({ ...JSON.parse(db.prepare('SELECT data FROM albums WHERE folder = ?').get(dir).data), groups: ['everyone'] }), dir);
assert.equal((await publish(dir)).status, 'done');
assert.deepEqual(ff.read('access/_everyone').albums, [id]);
assert.equal(await as('stranger@example.com', `albums/${id}`), 200, 'any signed-in account');

// removing a person takes their list away at once
people.removePerson('sister@example.com');
await fb.syncAccess();
assert.equal(ff.read('access/sister@example.com'), null);

// favourites, comments and asking for access, as the rules allow (the site does these through Firestore)
const DOCS = `${ff.base}/v1/projects/lamhaat-test/databases/(default)/documents`;
const asUser = (email, method, p, fields) => fetch(`${DOCS}/${p}`, { method, headers: { authorization: `Bearer ${ff.jwt(email)}`, 'content-type': 'application/json' }, ...(fields && { body: JSON.stringify({ fields }) }) }).then(r => r.status);
const str = v => ({ stringValue: v });
assert.equal(await asUser('stranger@example.com', 'PATCH', 'favs/stranger@example.com', { items: { arrayValue: { values: [str(`${id}/x`)] } } }), 200, 'anyone signed in keeps favourites');
assert.equal(await asUser('stranger@example.com', 'GET', 'favs/friend@example.com'), 403, 'but only their own');
assert.equal(await asUser('stranger@example.com', 'POST', `comments/${id}/items`, { by: str('stranger@example.com'), text: str('hi') }), 200, 'anyone signed in comments on an album for everyone');
assert.equal(await asUser('friend@example.com', 'POST', `comments/${id}/items`, { by: str('sister@example.com'), text: str('hi') }), 403, 'not in someone else’s name');
assert.equal(await asUser('stranger@example.com', 'PATCH', 'requests/stranger@example.com', { name: str('Stranger') }), 200, 'asking for access');
assert.deepEqual((await fb.requests()).map(r => r.email), ['stranger@example.com'], 'the owner sees who asked');
await fb.dismissRequest('stranger@example.com');
assert.deepEqual(await fb.requests(), []);

// "Lock again": a new key; everything is sealed anew, so a key someone saved before opens nothing
const oldKey = Buffer.from(ff.read(`albums/${id}`).key, 'base64');
const albumRow = () => JSON.parse(db.prepare('SELECT data FROM albums WHERE folder = ?').get(dir).data);
db.prepare('UPDATE albums SET data = ? WHERE folder = ?').run(JSON.stringify({ ...albumRow(), keyEpoch: 1 }), dir);
assert.equal((await publish(dir)).status, 'done');
const newKey = Buffer.from(ff.read(`albums/${id}`).key, 'base64');
assert.ok(!newKey.equals(oldKey), 'Firestore hands out the new key');
assert.ok(newKey.equals(fb.albumKey(loadKeys(), id, 1)));
const tryOpen = (k, buf) => { try { const d = crypto.createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(-16)); return Buffer.concat([d.update(buf.subarray(12, -16)), d.final()]); } catch { return null; } };
const relocked = JSON.parse(tryOpen(newKey, gh.show('lamhaat', `media/${media}/manifest.json`)));
const photoFile = gh.show('lamhaat', `media/${media}/${relocked.photos[0].v.thumb.path}`);
assert.equal(tryOpen(oldKey, photoFile), null, 'the old key opens nothing on the site');
assert.ok(tryOpen(newKey, photoFile), 'the new key does');
const fullFile = gh.show(relocked.photos[0].v.orig.site, relocked.photos[0].v.orig.path);
assert.equal(tryOpen(oldKey, fullFile), null, 'full-size copies are sealed anew too');

// signed out of Firebase: publishing still works, sharing waits
fb.ownerSignOut();
const later = await publish(dir);
assert.equal(later.status, 'done', JSON.stringify(later.error));
assert.equal(later.steps.find(s => s.id === 'share').status, 'skipped');

await gh.close(); await ff.close();
db.close();
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
console.log('ok');
