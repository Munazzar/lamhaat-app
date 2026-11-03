// Run: node --no-warnings desktop/test-swap.mjs
// Opening Lamhaat while an older version is still running (and idle): the old one steps aside and the new
// one takes its place, on the same port. The same version: the new one just opens a window onto it.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-swap-'));
const PORT = 5199, env = { ...process.env, LAMHAAT_DATA: tmp, LAMHAAT_PORT: String(PORT) };
const start = () => spawn(process.execPath, ['--no-warnings', path.join(import.meta.dirname, 'server.js'), '--no-window'], { env, stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));
const session = () => { try { return JSON.parse(fs.readFileSync(path.join(tmp, 'session.json'))); } catch { return null; } };
const alive = p => { try { process.kill(p, 0); return true; } catch { return false; } };

const a = start();
for (let i = 0; i < 50 && !session(); i++) await wait(200);
const first = session();
assert.equal(first.pid, a.pid);
// pretend it is an older version
fs.writeFileSync(path.join(tmp, 'session.json'), JSON.stringify({ ...first, version: 'older' }));
const b = start();
let now = null;
for (let i = 0; i < 50; i++) { await wait(200); now = session(); if (now?.pid === b.pid) break; }
try {
  assert.equal(now.pid, b.pid, 'the new version took over');
  assert.equal(now.port, PORT, 'on the same port');
  await wait(500);
  assert.ok(!alive(a.pid), 'the old one stopped');
  const r = await fetch(`http://127.0.0.1:${PORT}/api/library`, { headers: { cookie: `k=${now.key}` } });
  assert.equal(r.status, 200, 'and the new one answers');
  console.log('ok');
} finally {
  a.kill(); b.kill(); await wait(400);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}
