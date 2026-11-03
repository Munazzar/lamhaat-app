// Run: node --no-warnings desktop/test-fbbrowser.mjs
// Google sign-in from the person's own browser: the app makes a one-time link, the browser page (no
// session cookie) hands back Google's renewal key with it, and the app is signed in. A wrong or used link
// is refused.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-fbb-'));
const { fakeFirebase } = await import('./fake-firebase.mjs');
const ff = await fakeFirebase({ owner: 'owner@example.com' });
const PORT = 5197;
const env = { ...process.env, LAMHAAT_DATA: tmp, LAMHAAT_PORT: String(PORT), LAMHAAT_SECURETOKEN: `${ff.base}/v1`, LAMHAAT_FIRESTORE: `${ff.base}/v1` };
const server = spawn(process.execPath, ['--no-warnings', path.join(import.meta.dirname, 'server.js'), '--no-window'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
try {
  let key = null;
  for (let i = 0; i < 50 && !key; i++) { await new Promise(r => setTimeout(r, 200)); try { key = JSON.parse(fs.readFileSync(path.join(tmp, 'session.json'))).key; } catch {} }
  const base = `http://127.0.0.1:${PORT}`, app = { cookie: `k=${key}`, 'content-type': 'application/json' };
  const call = (p, b, headers = app) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(b) });
  assert.equal((await call('/api/firebase/browser', {})).status, 400, 'needs the settings first');
  assert.equal((await call('/api/firebase/details', { config: 'const firebaseConfig = { apiKey: "AIzaSyTestTestTestTestTestTestTest123", authDomain: "lamhaat-test.firebaseapp.com", projectId: "lamhaat-test", appId: "1:1:web:a" };' })).status, 200);
  const { link } = await (await call('/api/firebase/browser', { open: false })).json();
  assert.match(link, new RegExp(`^http://localhost:${PORT}/firebase/signin\\?s=[0-9a-f]{36}$`));
  const page = await fetch(link.replace('localhost', '127.0.0.1')); // the browser: no cookie
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /lamhaat-test\.firebaseapp\.com/); assert.match(html, /Sign in with Google/);
  assert.equal((await fetch(`${base}/firebase/signin?s=${'0'.repeat(36)}`)).status, 400, 'a made-up link is refused');
  const s = new URL(link).searchParams.get('s'), browser = { 'content-type': 'application/json' };
  assert.equal((await call('/firebase/signin', { s: 'nope', refreshToken: 'owner-refresh' }, browser)).status, 400);
  const ok = await call('/firebase/signin', { s, refreshToken: 'owner-refresh' }, browser);
  assert.deepEqual(await ok.json(), { owner: 'owner@example.com' });
  assert.equal((await call('/firebase/signin', { s, refreshToken: 'owner-refresh' }, browser)).status, 400, 'used once only');
  const st = await (await fetch(`${base}/api/firebase`, { headers: app })).json();
  assert.equal(st.owner, 'owner@example.com'); assert.equal(st.ready, true);
  console.log('ok');
} finally {
  server.kill(); await ff.close();
  await new Promise(r => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}
