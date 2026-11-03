// Lamhaat's service worker: unseals private albums in the browser. The page gives it the keys this
// viewer has (from Firestore, after Google sign-in); a request for p/<album>/<repo>/<file> is answered with
// media/<repo>/<file> decrypted (AES-256-GCM: 12-byte IV, ciphertext, 16-byte tag). Keys never leave
// this browser; signing out, or losing access, removes them.
const STORE = 'lamhaat-keys';
const keys = new Map(); // album id -> CryptoKey

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const importKey = b64 => crypto.subtle.importKey('raw', Uint8Array.from(atob(b64), c => c.charCodeAt(0)), 'AES-GCM', false, ['decrypt']);
const keyUrl = id => new URL(`__key/${id}`, self.registration.scope).href;

self.addEventListener('message', e => {
  if (e.data?.type !== 'keys') return;
  e.waitUntil((async () => {
    // exactly this set: anything no longer shared is forgotten
    keys.clear();
    await caches.delete(STORE);
    const c = await caches.open(STORE);
    for (const [id, k] of Object.entries(e.data.keys || {})) {
      if (!/^[a-z0-9]{10}$/.test(id) || typeof k !== 'string') continue;
      keys.set(id, await importKey(k));
      await c.put(keyUrl(id), new Response(k));
    }
    e.ports[0]?.postMessage('ok');
  })());
});

async function keyFor(id) { // after the browser restarts the worker, the keys come back from its own store
  if (keys.has(id)) return keys.get(id);
  const r = await (await caches.open(STORE)).match(keyUrl(id));
  if (!r) return null;
  const k = await importKey(await r.text());
  keys.set(id, k);
  return k;
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  const m = /^p\/([a-z0-9]{10})\/(@?[\w.-]+)\/(.+)$/.exec(url.pathname.slice(scope.length));
  if (!m) return;
  e.respondWith((async () => {
    const key = await keyFor(m[1]);
    if (!key) return new Response('This album isn’t shared with you.', { status: 403 });
    // @lamha-full-N: a full-size copy, from its own site next to this one
    const r = await fetch(new URL(m[2][0] === '@' ? `../${m[2].slice(1)}/${m[3]}` : `media/${m[2]}/${m[3]}`, self.registration.scope));
    if (!r.ok) return new Response('', { status: r.status });
    const buf = new Uint8Array(await r.arrayBuffer());
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
      return new Response(plain, { headers: { 'content-type': m[3].endsWith('.json') ? 'application/json' : m[2][0] === '@' ? 'image/jpeg' : 'image/avif', 'cache-control': 'private, max-age=86400' } });
    } catch { return new Response('Locked with another key.', { status: 403 }); }
  })());
});
