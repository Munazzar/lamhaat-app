// Private albums with Google sign-in, using only Firebase's free plan: no server of our own.
//   - Private albums are encrypted, each with its own key, and put next to the site like public ones.
//   - Firestore (Firebase's database) holds, for each private album, its details and its key, and for
//     each person, which albums they may open. Its security rules (rulesFor below, pasted once into the
//     Firebase console) let a signed-in Google account read only what is listed for it; only the owner
//     can write.
//   - Lamhaat writes all of that as the owner: you sign in with Google once inside the app, and the
//     sign-in is kept encrypted for your Windows account and renewed by itself.
import crypto from 'node:crypto';
import { db, setting, setSetting } from './db.js';
import { saveSecret, loadSecret, removeSecret } from './secrets.js';
import { Problem } from './github.js';
import { allowlist } from './people.js';

const STORE = () => process.env.LAMHAAT_FIRESTORE || 'https://firestore.googleapis.com/v1';
const TOKENS = () => process.env.LAMHAAT_SECURETOKEN || 'https://securetoken.googleapis.com/v1';
export const settings = () => JSON.parse(setting('firebase', '{}'));
const saveSettings = s => setSetting('firebase', JSON.stringify(s));

// the "firebaseConfig" snippet Firebase shows for a web app, pasted as is
export function parseConfig(text) {
  const get = k => new RegExp(`["']?${k}["']?\\s*:\\s*["']([^"']+)["']`).exec(String(text || ''))?.[1];
  const c = { apiKey: get('apiKey'), authDomain: get('authDomain'), projectId: get('projectId'), appId: get('appId') };
  if (!c.apiKey || !c.authDomain || !c.projectId || !c.appId) throw new Problem('firebase', 'That doesn’t look like the Firebase settings. Copy the whole “firebaseConfig” block from your Firebase project’s web app.');
  if (!/^[\w-]{20,60}$/.test(c.apiKey) || !/^[a-z0-9-]{4,40}$/.test(c.projectId)) throw new Problem('firebase', 'The Firebase settings look damaged. Copy them again.');
  return c;
}
export function saveDetails({ config, ownerName }) {
  const s = settings();
  if (config) { const c = parseConfig(config); if (s.config && s.config.projectId !== c.projectId) { delete s.owner; delete s.connected; removeSecret('firebase-owner'); } s.config = c; }
  if (ownerName != null) s.ownerName = String(ownerName).trim().slice(0, 60);
  saveSettings(s);
  siteSettings();
  return status();
}
// the web settings are public by design (they sit in the site's own page too), so the window may have them
export const status = () => { const s = settings(); return { config: s.config || null, owner: s.owner || null, ownerName: s.ownerName || '', ready: !!(s.config && s.owner && loadSecret('firebase-owner')), connected: s.connected === true, rulesOld: s.connected === true && (s.rulesVersion || 1) < RULES_VERSION }; };
export const isOn = () => status().ready;
// what the site needs to show "Sign in with Google": public by design (Firebase web settings are meant for browsers)
function siteSettings() {
  const s = settings();
  setSetting('siteConfig', s.config ? JSON.stringify({ firebase: s.config, ownerName: s.ownerName || '' }) : '');
}

// the security rules, with the owner's address written in, ready to paste into the Firebase console
export function rulesFor(owner) {
  const o = String(owner || 'you@gmail.com').toLowerCase().replace(/['\\]/g, '');
  return `rules_version = '2';
// Lamhaat: who may open which private album. Only ${o} can change anything.
service cloud.firestore {
  match /databases/{db}/documents {
    function signedIn() { return request.auth != null && request.auth.token.email_verified == true; }
    function me() { return request.auth.token.email.lower(); }
    function owner() { return signedIn() && me() == '${o}'; }
    function listedFor(who, id) { return exists(/databases/$(db)/documents/access/$(who)) && id in get(/databases/$(db)/documents/access/$(who)).data.albums; }
    function sees(id) { return owner() || (signedIn() && (listedFor(me(), id) || listedFor('_everyone', id))); }
    function canSee(id) { return sees(id) || (signedIn() && listedFor('_public', id)); }
    match /access/{who} {
      allow get: if owner() || (signedIn() && (who == me() || who == '_everyone' || who == '_public'));
      allow list, write: if owner();
    }
    match /albums/{id} {
      allow get: if sees(id);
      allow list, write: if owner();
    }
    // each viewer's favourites: theirs alone
    match /favs/{who} {
      allow get, write: if signedIn() && who == me();
    }
    // comments under the photos of an album you can see; yours to delete, and the owner can delete any
    match /comments/{album}/items/{item} {
      allow get, list: if canSee(album);
      allow create: if canSee(album) && request.resource.data.by == me() && request.resource.data.text is string
        && request.resource.data.text.size() > 0 && request.resource.data.text.size() <= 1000;
      allow delete: if owner() || (signedIn() && resource.data.by == me());
    }
    // "ask for access": anyone signed in can ask once; only the owner reads the list
    match /requests/{who} {
      allow get, create, update: if signedIn() && who == me();
      allow list, delete: if owner();
    }
  }
}
`;
}
// bumped when the rules above change, so the People screen asks for them to be pasted again
export const RULES_VERSION = 2;

// ---------- the owner's sign-in ----------
let cached = null; // { token, exp }
async function exchange(refresh) {
  const s = settings();
  let r;
  try {
    r = await fetch(`${TOKENS()}/token?key=${encodeURIComponent(s.config.apiKey)}`, { method: 'POST', signal: AbortSignal.timeout(30e3),
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }) }).then(r => r.json());
  } catch { throw new Problem('offline', 'Can’t reach Google. Check the internet connection.'); }
  if (!r.id_token) throw new Problem('fbsignin', 'Google no longer accepts the Lamhaat sign-in for your Firebase project. Sign in with Google again on People & sharing.');
  const claims = JSON.parse(Buffer.from(r.id_token.split('.')[1], 'base64url').toString());
  return { token: r.id_token, refresh: r.refresh_token || refresh, email: String(claims.email || '').toLowerCase(), verified: claims.email_verified === true, exp: claims.exp * 1000 };
}
// the window signs in with Google (Firebase's own popup) and hands over the renewal key
export async function ownerSignIn(refresh) {
  if (!settings().config) throw new Problem('firebase', 'Paste the Firebase settings first.');
  const t = await exchange(String(refresh || ''));
  if (!t.email || !t.verified) throw new Problem('fbsignin', 'That Google account has no confirmed email address.');
  saveSecret('firebase-owner', t.refresh);
  saveSettings({ ...settings(), owner: t.email });
  cached = { token: t.token, exp: t.exp };
  return status();
}
export function ownerSignOut() { removeSecret('firebase-owner'); const s = settings(); delete s.owner; saveSettings(s); cached = null; }
async function token() {
  if (cached && cached.exp - Date.now() > 5 * 60e3) return cached.token;
  const refresh = loadSecret('firebase-owner');
  if (!refresh) throw new Problem('fbsignin', 'Sign in with Google on People & sharing first.');
  const t = await exchange(refresh);
  if (t.refresh !== refresh) saveSecret('firebase-owner', t.refresh);
  cached = { token: t.token, exp: t.exp };
  return t.token;
}

// ---------- Firestore, through its plain web interface ----------
const enc = v => v === null || v === undefined ? { nullValue: null }
  : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : typeof v === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } }
  : { stringValue: String(v) };
export const dec = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue
  : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec)
  : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : null;
async function store(method, docPath, body) {
  const s = settings();
  const url = `${STORE()}/projects/${s.config.projectId}/databases/(default)/documents/${docPath.split('/').map(encodeURIComponent).join('/')}`;
  let res;
  try { res = await fetch(url, { method, signal: AbortSignal.timeout(30e3), headers: { authorization: `Bearer ${await token()}`, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) }); }
  catch (e) { if (e instanceof Problem) throw e; throw new Problem('offline', 'Can’t reach Firebase. Check the internet connection.'); }
  if (res.status === 404 && method !== 'PATCH') return null;
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const msg = data.error?.message || res.statusText;
  if (res.status === 403) throw new Problem('rules', `Firebase refused: ${msg}. Paste the rules from Lamhaat into Firestore → Rules and press Publish (they must name ${s.owner}).`);
  if (res.status === 404) throw new Problem('nostore', 'This Firebase project has no Firestore database yet. Create one (Build → Firestore Database → Create database).');
  if (res.status === 429 || res.status >= 500) throw new Problem('server', `Firebase is busy right now (${res.status}).`);
  throw new Problem('firebase', `Firebase said: ${msg}`);
}
const put = (p, obj) => store('PATCH', p, { fields: enc(obj).mapValue.fields });
const del = p => store('DELETE', p);
export async function get(p) { const d = await store('GET', p); return d ? dec({ mapValue: { fields: d.fields || {} } }) : null; }

// a quick proof that everything is in place: the database exists, the rules let the owner write
export async function check() {
  const at = new Date().toISOString();
  await put('albums/_check', { at });
  const back = await get('albums/_check');
  await del('albums/_check');
  if (back?.at !== at) throw new Problem('firebase', 'Firebase didn’t keep what was written. Try again.');
  // the newer parts of the rules (favourites, comments, asking for access) are there too: the owner's own favourites
  try { await put(`favs/${settings().owner}`, { check: at }); await del(`favs/${settings().owner}`); }
  catch (e) { if (e.kind === 'rules') throw new Problem('rules', 'Your Firestore rules are the older ones. Copy the rules from Lamhaat again, paste them into Firestore → Rules and press Publish.'); throw e; }
  saveSettings({ ...settings(), connected: true, rulesVersion: RULES_VERSION });
  return true;
}

// ---------- sharing ----------
// each private album's own key: derived from the library key, so it never needs storing, and one album's
// key opens nothing else
// "Lock again" moves an album to its next key (epoch); the first key is the one it always had
export const albumKey = (keys, id, epoch = 0) => crypto.createHmac('sha256', keys.enc).update(epoch ? `album:${id}:${epoch}` : `album:${id}`).digest();
const shared = () => JSON.parse(setting('sharedAlbums', '{}'));
// a private album is published: its details and key go to Firestore, readable only as the rules allow
export async function shareAlbum(entry, keyBytes) {
  await put(`albums/${entry.id}`, {
    title: entry.title, dateStart: entry.dateStart, dateEnd: entry.dateEnd, count: entry.count, cover: entry.cover,
    repos: entry.repos, groups: entry.groups, key: Buffer.from(keyBytes).toString('base64'), updatedAt: new Date().toISOString(),
  });
  setSetting('sharedAlbums', JSON.stringify({ ...shared(), [entry.id]: entry.groups }));
  return syncAccess();
}
export async function unshareAlbum(id) {
  await del(`albums/${id}`);
  const s = shared(); delete s[id];
  setSetting('sharedAlbums', JSON.stringify(s));
  return syncAccess();
}
// who may open what: one short list per person (and one for "anyone signed in"), written in full each time
export async function syncAccess() {
  const albums = shared(), people = allowlist();
  // public albums too, so signed-in viewers can leave comments under them
  const publicIds = db.prepare('SELECT data FROM albums').all().map(r => JSON.parse(r.data)).filter(d => d.public && d.id).map(d => d.id);
  const lists = { _everyone: Object.keys(albums).filter(id => albums[id].includes('everyone')), _public: publicIds };
  for (const [email, groups] of Object.entries(people)) lists[email] = Object.keys(albums).filter(id => albums[id].some(g => groups.includes(g)));
  for (const [who, ids] of Object.entries(lists)) await put(`access/${who}`, { albums: ids });
  const before = JSON.parse(setting('accessWritten', '[]'));
  for (const who of before) if (!(who in lists)) await del(`access/${who}`); // removed people: their list goes
  setSetting('accessWritten', JSON.stringify(Object.keys(lists)));
  return { people: Object.keys(people).length, albums: Object.keys(albums).length };
}

// ---------- asking for access: who asked on the site, for the owner to add or dismiss ----------
export async function requests() {
  const s = settings();
  if (!isOn()) return [];
  const r = await fetch(`${STORE()}/projects/${s.config.projectId}/databases/(default)/documents/requests?pageSize=100`, { headers: { authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(20e3) }).catch(() => null);
  if (!r?.ok) return [];
  return ((await r.json()).documents || []).map(d => ({ email: d.name.split('/').pop(), ...dec({ mapValue: { fields: d.fields || {} } }) }));
}
export const dismissRequest = email => del(`requests/${String(email).toLowerCase()}`);
