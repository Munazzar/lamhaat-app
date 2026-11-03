// Where the gallery gets catalog, manifests and image URLs.
// Public albums come from next to the site (GitHub Pages; or the export staging folder via scripts/dev.js).
// Private albums sit next to the site too, but sealed, each with its own key. With Google sign-in set up
// (config.json carries the Firebase web settings), a signed-in viewer asks Firestore which private albums
// they may open; Firestore's rules hand out those albums' details and keys and nothing else. The keys go
// to the service worker (sw.js), which unseals each photo in the browser as it loads.
import { idToken, user } from './auth.js';

const MEDIA = 'media'; // relative: works at / locally and under /lamhaat/ on Pages
let cfg = null;
const albums = new Map();
const sealed = new Set(); // private albums: their files come through the service worker
let currentAlbum = null;

export async function config() {
  try { const r = await fetch('config.json', { cache: 'no-cache' }); if (r.ok) { const c = await r.json(); if (c.firebase) cfg = c; } } catch {}
  // always: it makes the site installable as an app, and unseals private albums once signed in
  if ('serviceWorker' in navigator) await navigator.serviceWorker.register('sw.js').catch(() => {});
  return cfg;
}

// Firestore, read as the signed-in viewer; its rules decide what comes back
const STORE = () => `${cfg.firestore || 'https://firestore.googleapis.com/v1'}/projects/${cfg.firebase.projectId}/databases/(default)/documents`;
const dec = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue
  : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec)
  : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : null;
async function doc(path) {
  const r = await fetch(`${STORE()}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { authorization: `Bearer ${await idToken()}` } });
  if (r.status === 404 || r.status === 403) return null; // not there, or not for this viewer
  if (!r.ok) throw new Error(`Private albums can’t be reached right now (${r.status}).`);
  return dec({ mapValue: { fields: (await r.json()).fields || {} } });
}
async function ownerList() { // the owner may list every private album; for anyone else this is refused
  const r = await fetch(`${STORE()}/albums?pageSize=300`, { headers: { authorization: `Bearer ${await idToken()}` } });
  if (!r.ok) return null;
  return ((await r.json()).documents || []).map(d => ({ id: d.name.split('/').pop(), ...dec({ mapValue: { fields: d.fields || {} } }) }));
}
// hand the service worker exactly the keys this viewer has now (keys of albums taken away go)
async function keysToWorker(keys) {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const ch = new MessageChannel();
  const done = new Promise(r => { ch.port1.onmessage = r; setTimeout(r, 3000); });
  reg.active?.postMessage({ type: 'keys', keys }, [ch.port2]);
  await done;
}
export const forgetKeys = () => keysToWorker({});

// the public albums, plus the private ones this viewer may see; `who` says how that went
export async function catalog() {
  const res = await fetch(`${MEDIA}/lamha-catalog/catalog.json`, { cache: 'no-cache' }).catch(() => null);
  const pub = res?.ok ? await res.json() : { schema: 1, albums: [] };
  if (!cfg || !user()) { if (!res?.ok && !cfg) throw new Error('catalog unavailable'); return { ...pub, who: null }; }
  let mine = [], who = { email: user().email };
  try {
    const all = await ownerList();
    if (all) { mine = all.filter(a => a.id !== '_check'); who.owner = true; }
    else {
      const ids = new Set([...((await doc(`access/${user().email.toLowerCase()}`))?.albums || []), ...((await doc('access/_everyone'))?.albums || [])]);
      mine = (await Promise.all([...ids].map(id => doc(`albums/${id}`).then(a => a && { id, ...a })))).filter(Boolean);
    }
    who.count = mine.length;
  } catch (err) { who = { ...who, error: err.message }; }
  mine = mine.filter(a => !pub.albums.some(p => p.id === a.id));
  await keysToWorker(Object.fromEntries(mine.map(a => [a.id, a.key])));
  sealed.clear(); for (const a of mine) sealed.add(a.id);
  return { ...pub, albums: [...pub.albums, ...mine.map(({ key, groups, updatedAt, ...a }) => ({ ...a, encrypted: true, private: true }))], who };
}

export async function album(entry) {
  currentAlbum = entry.id;
  if (!albums.has(entry.id)) {
    const p = fetch(sealed.has(entry.id) ? `p/${entry.id}/${entry.repos[0]}/manifest.json` : `${MEDIA}/${entry.repos[0]}/manifest.json`, { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error(r.status === 403 ? 'This album isn’t shared with you (any more).' : 'album unavailable'); return r.json(); })
      .then(m => {
        if (m.schema !== 1) throw new Error(`This album needs a newer version of Lamhaat (schema ${m.schema}).`);
        return m;
      });
    p.catch(() => albums.delete(entry.id));
    albums.set(entry.id, p);
  }
  return albums.get(entry.id);
}

// a private album's files are asked for under p/<album>/..., which the service worker unseals
// full-size copies live in their own small sites next to this one (lamha-full-N, same address): ../lamha-full-N/...
export const src = (v, albumId = currentAlbum) => v.site
  ? (sealed.has(albumId) ? `p/${albumId}/@${v.site}/${v.path}` : `../${v.site}/${v.path}`)
  : sealed.has(albumId) ? `p/${albumId}/${v.repo}/${v.path}` : `${MEDIA}/${v.repo}/${v.path}`;

// ---------- favourites, comments, asking for access: the viewer's own, through Firestore (its rules decide) ----------
const enc = v => typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { nullValue: null };
async function fs(method, path, fields) {
  const r = await fetch(`${STORE()}/${path}`, { method, headers: { authorization: `Bearer ${await idToken()}`, 'content-type': 'application/json' },
    ...(fields && { body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)])) }) }) });
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) throw new Error(r.status === 403 ? 'Not allowed.' : `Couldn’t reach the server (${r.status}).`);
  return r.json();
}
// signed in, with Google sign-in set up: the things only a signed-in viewer can do
export const social = () => !!(cfg && user());
const me = () => user().email.toLowerCase();

let favSet = null;
export async function favourites() {
  if (!social()) return new Set();
  favSet ||= fs('GET', `favs/${encodeURIComponent(me())}`).then(d => new Set(d?.fields?.items ? dec(d.fields.items) : [])).catch(() => new Set());
  return favSet;
}
export async function toggleFavourite(albumId, h) {
  const set = await favourites(), k = `${albumId}/${h}`;
  set.has(k) ? set.delete(k) : set.add(k);
  await fs('PATCH', `favs/${encodeURIComponent(me())}`, { items: [...set] });
  return set.has(k);
}

const commentCache = new Map();
export function comments(albumId) {
  if (!commentCache.has(albumId)) {
    const p = fs('GET', `comments/${albumId}/items?pageSize=300`).then(d => (d?.documents || []).map(x => ({ id: x.name.split('/').pop(), ...dec({ mapValue: { fields: x.fields || {} } }) })).sort((a, b) => a.at.localeCompare(b.at)));
    p.catch(() => commentCache.delete(albumId));
    commentCache.set(albumId, p);
  }
  return commentCache.get(albumId);
}
export async function addComment(albumId, h, text) {
  const c = { by: me(), name: user().displayName || me(), photo: h, text: text.trim().slice(0, 1000), at: new Date().toISOString() };
  const d = await fs('POST', `comments/${albumId}/items`, c);
  const list = await comments(albumId);
  list.push({ id: d.name.split('/').pop(), ...c });
  return list;
}
export async function deleteComment(albumId, id) {
  await fs('DELETE', `comments/${albumId}/items/${id}`);
  const list = await comments(albumId);
  list.splice(list.findIndex(c => c.id === id), 1);
  return list;
}
export const askForAccess = () => fs('PATCH', `requests/${encodeURIComponent(me())}`, { name: user().displayName || '', at: new Date().toISOString() });
export const forgetSocial = () => { favSet = null; commentCache.clear(); };
export const myEmail = () => user()?.email?.toLowerCase() || null;
