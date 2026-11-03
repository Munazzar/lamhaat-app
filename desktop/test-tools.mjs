// The programs Lamhaat uses, on a PC that has none of them: found missing, downloaded (from a server on this
// PC standing in for the internet), unpacked where the app looks, and a failed download said plainly.
// usage: node desktop/test-tools.mjs <LibRaw-…-Win64.zip>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-tools-test-'));
const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
// a bare PC: no Git or Ollama on the PATH or where their installers put them, no AI server answering
Object.assign(process.env, { LAMHAAT_DATA: path.join(tmp, 'data'), LOCALAPPDATA: path.join(tmp, 'local'), PATH: `${sys};${path.join(sys, 'WindowsPowerShell', 'v1.0')}` });
fs.mkdirSync(process.env.LAMHAAT_DATA, { recursive: true });

// a stand-in MinGit: a zip with cmd\git.exe in it
const mingit = path.join(tmp, 'mingit');
fs.mkdirSync(path.join(mingit, 'cmd'), { recursive: true });
fs.copyFileSync(path.join(sys, 'where.exe'), path.join(mingit, 'cmd', 'git.exe'));
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${mingit}\\*' -DestinationPath '${tmp}\\mingit.zip'`]);
const files = { '/mingit.zip': path.join(tmp, 'mingit.zip'), '/libraw.zip': process.argv[2] };
const server = http.createServer((req, res) => {
  const f = files[req.url];
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, { LAMHAAT_URL_GIT: `${base}/mingit.zip`, LAMHAAT_URL_LIBRAW: `${base}/libraw.zip`, LAMHAAT_URL_OLLAMA: `${base}/missing.exe` });

const db = await import('./db.js');
db.setSetting('ollama', 'http://127.0.0.1:9'); // nothing listens there
const tools = await import('./tools.js');
const raw = await import('./raw.js');
const by = async id => (await tools.status()).find(t => t.id === id);

// 1. what is missing is found missing
assert.equal((await by('git')).ok, false, 'no Git yet');
assert.equal((await by('ollama')).ok, false, 'no Ollama yet');
assert.equal((await by('ollama')).running, false);
assert.equal((await by('model')).unknown, true, 'the model can’t be checked without the AI server');
assert.equal((await by('raw')).ok, false, 'no RAW reader yet');
assert.equal(await tools.startOllama(), false, 'nothing to start');
console.log('1 missing programs found missing');

// 2. installing: progress, then where the app looks for it
const seen = [];
await tools.install('git', p => seen.push(p));
assert.ok((await by('git')).ok, 'Git is there now');
assert.equal(tools.gitPath(), path.join(process.env.LAMHAAT_DATA, 'tools', 'git', 'cmd', 'git.exe'), 'publishing uses the installed Git');
await tools.install('raw');
assert.ok((await by('raw')).ok && raw.status().raw, 'the RAW reader is there now');
for (const f of ['dcraw_emu.exe', 'libraw.dll']) assert.ok(fs.existsSync(path.join(process.env.LAMHAAT_DATA, 'tools', 'libraw', f)), f);
console.log('2 Git and the RAW reader installed', seen.length ? `(${seen.length} progress updates)` : '');

// 3. a RAW reader that isn't given a RAW file says so, not a crash
const notRaw = path.join(tmp, 'photo.raf');
fs.writeFileSync(notRaw, 'not a raw file');
await assert.rejects(raw.develop(notRaw, 'abc'), e => e.kind === 'develop' && /photo\.raf/.test(e.message));
console.log('3 a broken RAW file: a plain message');

// 4. failures: a download that isn't there, an unknown program, the model without the AI server
await assert.rejects(tools.install('ollama'), e => e.kind === 'offline');
await assert.rejects(tools.install('nope'), e => e.kind === 'tool');
await assert.rejects(tools.install('model'), e => e.kind === 'noollama');
assert.equal((await by('ollama')).installing, null, 'not stuck as installing after a failure');
console.log('4 failures are said plainly and leave nothing half-done');

server.close();
db.db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('all tools tests passed');
