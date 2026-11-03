// Lamhaat desktop: a small local server and a window onto it (Edge in app mode, already on every
// Windows PC, so there is nothing to install). It listens on 127.0.0.1 only, and every request must
// carry this session's key, so websites open in your normal browser can't talk to it.
// usage: node desktop/server.js        (or double-click Lamhaat.cmd)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { spawn, execFile } from 'node:child_process';
import { db, dataDir, setting, setSetting, previewPath } from './db.js';
import { importFolder, isImporting, listPhotos } from './ingest.js';
import { analyseFolder, isAnalysing, unscoredCount, photosWithFlags } from './analyse.js';
import { inAlbum, defaultAlbum, clean } from './album.js';
import * as meta from './meta.js';
import { tidy } from './edit.js';
import { edited } from './render.js';
import * as github from './github.js';
import { publish, publishSite, isPublishing, cancelPublish, lastRun, adoptFromGitHub, purgeAlbum } from './publish.js';
import * as people from './people.js';
import * as firebase from './firebase.js';
import * as ai from './ai.js';
import * as upscale from './upscale.js';
import * as embeds from './embeds.js';
import { recoveryCode, restoreKeys } from '../scripts/keys.js';
import * as raw from './raw.js';
import * as tools from './tools.js';
const { readable } = raw;


const HOST = '127.0.0.1';
let PORT = Number(process.env.LAMHAAT_PORT) || 5190; // the next free one if another program has it
const callback = () => `http://${HOST}:${PORT}/github/callback`; // GitHub accepts any port for 127.0.0.1, so moving port is fine
const UI = path.join(import.meta.dirname, 'ui');
const sessionFile = path.join(dataDir, 'session.json');
const key = crypto.randomBytes(24).toString('hex');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

function openWindow(k) {
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
  const url = `http://localhost:${PORT}/?k=${k}`; // not 127.0.0.1: Google sign-in (Firebase) only trusts localhost
  if (!edge) return console.log(`Open ${url} in your browser`);
  spawn(edge, [`--app=${url}`, `--user-data-dir=${path.join(dataDir, 'window')}`, '--window-size=1440,920', '--no-first-run'], { detached: true, stdio: 'ignore' }).unref();
}

// ---- events to the window (import progress), and quitting when the window is closed ----
const clients = new Set();
let everConnected = false, quitTimer = 0;
const send = (type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
const maybeQuit = () => {
  clearTimeout(quitTimer);
  if (everConnected && !clients.size && !busy()) quitTimer = setTimeout(() => process.exit(0), 8000);
};

// ---- jobs: import, then check quality; one at a time ----
let pendingSignIn = null; // a browser sign-in waiting for its code to be approved
const busy = () => isImporting() || isAnalysing() || isPublishing() || !!upJob;
const throttled = type => { let last = 0; return p => { const now = Date.now(); if (now - last > 120 || p.done === p.total) { last = now; send(type, p); } }; };
async function runCheck(folder) {
  try { send('checked', await analyseFolder(folder, throttled('progress'))); }
  catch (err) { send('job-failed', { folder, error: String(err.message || err) }); }
  maybeQuit();
}
async function runImport(folder) {
  try {
    const r = await importFolder(folder, (p => { const f = throttled('progress'); return x => f({ ...x, phase: 'reading' }); })());
    send('imported', r);
    await runCheck(r.folder);
  } catch (err) { send('job-failed', { folder, error: String(err.message || err) }); maybeQuit(); }
}

// ---- full-quality copies for the large view ----
const making = new Map(); // sha -> promise, so two requests for one photo make it once
function fullSize(sha) {
  const out = path.join(dataDir, 'previews', 'full', `${sha}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (!making.has(sha)) making.set(sha, (async () => {
    const src = db.prepare('SELECT path FROM photos WHERE sha256 = ? LIMIT 1').get(sha)?.path;
    if (!src) throw new Error('not found');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp(readable(src, sha), { failOn: 'none' }).rotate().resize(3200, 3200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90, mozjpeg: true }).toFile(`${out}.part`);
    fs.renameSync(`${out}.part`, out);
    return out;
  })().finally(() => making.delete(sha)));
  return making.get(sha);
}

// AI work waits its turn: describe a shoot first (that also counts the people in each photo), then
// look for the people tagged there. Tagging a person queues a search for them by itself.
const aiQueue = [];
let aiRunning = false;
function aiLater(task) {
  if (task.ids || !aiQueue.some(t => t.kind === task.kind && t.folder === task.folder && t.tagId === task.tagId && !t.ids)) aiQueue.push(task);
  send('ai', { queued: aiQueue.length, job: ai.aiJob() });
  setTimeout(aiNext, 1500); // a moment, so a few quick tags make one search
}
async function aiNext() {
  if (aiRunning || !aiQueue.length) return;
  aiRunning = true;
  const task = aiQueue.shift();
  const progress = (() => { let last = 0; return p => { const now = Date.now(); if (now - last > 400 || p.done === p.total) { last = now; send('ai', { job: p, queued: aiQueue.length }); } }; })();
  try {
    if (task.ids) { // "process again": these photos, described afresh, with the owner's instructions
      const r = await ai.describeFolder(task.folder, progress, { ids: task.ids, note: task.note });
      send('ai-done', { kind: 'describe', folder: task.folder, done: r.done, errors: r.errors, cancelled: r.cancelled });
    } else if (ai.undescribed(task.folder).length) {
      const r = await ai.describeFolder(task.folder, progress);
      send('ai-done', { kind: 'describe', folder: task.folder, done: r.done, errors: r.errors, cancelled: r.cancelled });
    }
    if (task.kind === 'find') {
      const r = await ai.findPerson(task.folder, task.tagId, progress);
      send('ai-done', { kind: 'find', folder: task.folder, person: r.person, tagId: task.tagId, tagged: r.tagged, checked: r.done, cancelled: r.cancelled });
    }
  } catch (e) { send('ai-done', { kind: task.kind, folder: task.folder, error: e.message }); aiQueue.length = 0; }
  finally { aiRunning = false; setTimeout(aiNext, 200); }
}

// enhancing photos, one after another (they share the graphics card); the new photos join their shoots
let upJob = null;
async function runUpscale(photos, mode, useAi) {
  upJob = { done: 0, total: photos.length, errors: [], files: [] };
  for (const p of photos) {
    try {
      const r = await upscale.enhance(p, mode, { ai: useAi, onProgress: f => send('upscale', { done: upJob.done + f, total: upJob.total, current: p.name }) });
      upJob.files.push(r.file);
    } catch (e) { upJob.errors.push({ file: p.name, error: e.message }); }
    upJob.done++;
  }
  const r = { done: upJob.files.length, errors: upJob.errors, ai: useAi, finished: true, folders: [...new Set(photos.map(p => p.folder))] };
  upJob = null;
  send('upscale', r);
  // the new photos come in like any others (and are grouped with their originals by the check)
  for (const f of r.folders) { while (busy()) await new Promise(res => setTimeout(res, 1000)); await runImport(f); }
}

// AI noise removal, in one go (the model loads once). A RAW photo is developed again, cleaner, in place;
// a JPEG gets a cleaner copy as a new photo in the shoot's Enhanced folder.
async function runDenoise(photos) {
  upJob = { done: 0, total: photos.length };
  const jobs = photos.map(p => raw.RAW.test(p.path)
    ? { in: p.path, out: raw.developedPath(p.sha256), raw: true, denoise: true }
    : { in: p.path, out: path.join(p.folder, 'Enhanced', `${path.parse(p.name).name} (AI noise removed).jpg`), denoise: true });
  for (const j of jobs) fs.mkdirSync(path.dirname(j.out), { recursive: true });
  let results = [];
  try { results = await raw.run(jobs, (i, f) => { upJob.done = i + f; send('upscale', { done: i + f, total: photos.length, current: photos[i].name }); }); }
  catch (e) { results = photos.map(() => ({ error: e.message })); }
  upJob = null;
  const errors = results.map((r, i) => r.error && { file: photos[i].name, error: r.error }).filter(Boolean);
  // RAW photos: their previews, full-size copies and checks were made from the noisy picture
  for (const [i, p] of photos.entries()) if (!results[i].error && raw.RAW.test(p.path)) {
    for (const f of [previewPath(p.sha256), path.join(dataDir, 'previews', 'full', `${p.sha256}.jpg`)]) fs.rmSync(f, { force: true });
    db.prepare('DELETE FROM scores WHERE photo_id = ?').run(p.id);
    db.prepare('UPDATE photos SET mtime = -1 WHERE id = ?').run(p.id);
  }
  const folders = [...new Set(photos.map(p => p.folder))];
  send('upscale', { finished: true, kind: 'denoise', done: photos.length - errors.length, errors, ai: true, folders });
  for (const f of folders) { while (busy()) await new Promise(res => setTimeout(res, 1000)); await runImport(f); }
}

// the people list online follows every change; if that fails, the next setup run copies it again
async function syncQuietly() {
  if (!firebase.isOn()) return 'local';
  try { await firebase.syncAccess(); return 'synced'; } catch (e) { return `not copied online yet: ${e.message}`; }
}

// photo ids from the window: whole numbers that exist
const ownIds = ids => {
  if (!Array.isArray(ids) || !ids.length || ids.length > 20000 || !ids.every(Number.isInteger)) return null;
  const n = db.prepare(`SELECT count(*) n FROM photos WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids).n;
  return n === new Set(ids).size ? ids : null;
};

// ---- the API ----
const body = req => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', d => { s += d; if (s.length > 1e6) reject(new Error('Too large')); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('Bad JSON')); } });
});
const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };

function folderList() {
  const root = setting('root', 'D:\\Photography');
  const known = new Map(db.prepare(`SELECT f.path, f.imported_at, count(p.id) n FROM folders f LEFT JOIN photos p ON p.folder = f.path GROUP BY f.path`).all().map(r => [r.path, r]));
  const subs = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => path.join(root, e.name)) : [];
  const all = [...new Set([...subs, ...known.keys()])];
  return { root, rootExists: fs.existsSync(root), folders: all.map(p => ({ path: p, name: path.basename(p), imported: known.get(p)?.imported_at || null, count: known.get(p)?.n || 0, exists: fs.existsSync(p) })).sort((a, b) => a.name.localeCompare(b.name)) };
}

const routes = {
  'GET /api/library': () => [200, { ...folderList(), busy: busy() }],
  // Windows' own "Select folder" window, on top of Lamhaat; null if the person cancels
  'POST /api/pick-folder': async req => {
    const { start = '', title = 'Choose a folder' } = await body(req);
    const out = await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, 'pick-folder.ps1'), '-Start', String(start), '-Title', String(title)],
      { windowsHide: true, timeout: 600e3 }, (err, stdout) => resolve(err ? '' : String(stdout).trim())));
    return [200, { path: out && fs.existsSync(out) ? out : null }];
  },
  'POST /api/root': async req => {
    const { root } = await body(req);
    if (typeof root !== 'string' || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [400, { error: 'That folder doesn’t exist.' }];
    setSetting('root', path.resolve(root));
    return [200, folderList()];
  },
  'GET /api/photos': (req, url) => {
    const folder = path.resolve(url.searchParams.get('folder') || '');
    return [200, { folder, ...photosWithFlags(folder), unscored: unscoredCount(folder) }];
  },
  'GET /api/scan': (req, url) => {
    const folder = url.searchParams.get('folder') || '';
    if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) return [400, { error: 'That folder doesn’t exist.' }];
    const { photos, skipped } = listPhotos(folder);
    const bytes = photos.reduce((s, f) => s + fs.statSync(f).size, 0);
    return [200, { photos: photos.length, skipped: skipped.length, bytes }];
  },
  'POST /api/import': async req => {
    const { folder } = await body(req);
    if (typeof folder !== 'string' || !fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) return [400, { error: 'That folder doesn’t exist.' }];
    if (busy()) return [409, { error: 'Another import or check is running.' }];
    runImport(folder);
    return [202, { started: true }];
  },
  // keep / reject / undecided for some photos of one shoot, all or nothing
  'POST /api/decide': async req => {
    const { folder, changes } = await body(req);
    const f = path.resolve(String(folder || ''));
    if (!Array.isArray(changes) || !changes.length || changes.length > 20000
      || !changes.every(c => Number.isInteger(c?.id) && ['undecided', 'keep', 'reject'].includes(c.decision))) return [400, { error: 'Bad decisions.' }];
    const set = db.prepare('UPDATE photos SET decision = ? WHERE id = ? AND folder = ?');
    db.exec('BEGIN');
    try {
      for (const c of changes) if (!set.run(c.decision, c.id, f).changes) throw new Error('Some photos are no longer in this shoot. Reopen it and try again.');
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); return [409, { error: err.message }]; }
    return [200, { saved: changes.length }];
  },
  // ---- tags and people, titles and descriptions, edits ----
  'GET /api/tags': () => [200, { tags: meta.allTags() }],
  'POST /api/tags/apply': async req => {
    const b = await body(req), ids = ownIds(b.ids);
    if (!ids) return [400, { error: 'Bad photos.' }];
    if (b.kind != null && !['tag', 'person'].includes(b.kind)) return [400, { error: 'Bad kind.' }];
    const id = meta.tagPhotos(ids, { name: b.name, kind: b.kind, tagId: Number.isInteger(b.tagId) ? b.tagId : undefined, remove: b.remove === true });
    if (db.prepare('SELECT kind FROM tags WHERE id = ?').get(id)?.kind === 'person') {
      if (b.remove === true && b.undo !== true) ai.notThem(id, ids); // "not this person": never auto-tagged there again (Ctrl+Z of a tag just added isn't that)
      else for (const f of new Set(ids.map(x => db.prepare('SELECT folder FROM photos WHERE id = ?').get(x).folder))) aiLater({ kind: 'find', folder: f, tagId: id });
    }
    return [200, { id, tags: meta.allTags() }];
  },
  'POST /api/tags/rename': async req => { const b = await body(req); const id = meta.renameTag(Number(b.id), b.name); return [200, { id, tags: meta.allTags() }]; },
  'POST /api/tags/delete': async req => { meta.deleteTag(Number((await body(req)).id)); return [200, { tags: meta.allTags() }]; },
  'POST /api/photo/text': async req => {
    const b = await body(req), ids = ownIds([b.id]);
    if (!ids) return [400, { error: 'Bad photo.' }];
    meta.setText(ids[0], { title: b.title, description: b.description });
    return [200, {}];
  },
  'POST /api/photo/edits': async req => {
    const b = await body(req), ids = ownIds([b.id]);
    if (!ids) return [400, { error: 'Bad photo.' }];
    const e = tidy(b.edits);
    meta.setEdits(ids[0], e);
    return [200, { edits: e }];
  },

  // a shoot's album: title, chapters, cover, highlights (a first suggestion until it is saved once)
  'GET /api/album': (req, url) => {
    const folder = path.resolve(url.searchParams.get('folder') || '');
    const row = db.prepare('SELECT data FROM albums WHERE folder = ?').get(folder);
    const stored = row ? JSON.parse(row.data) : null, saved = !!stored && !stored.unsaved;
    const photos = inAlbum(db.prepare('SELECT id, name, taken, decision FROM photos WHERE folder = ?').all(folder));
    // published or made public before being arranged here: the first suggestion, with its id and visibility
    return [200, { album: clean(saved ? stored : { ...defaultAlbum(path.basename(folder), photos), id: stored?.id, public: stored?.public, groups: stored?.groups }, photos), saved }];
  },
  // an album arranged by hand on GitHub before this app: bring its words and chapters in
  'POST /api/album/adopt': async req => {
    const f = path.resolve(String((await body(req)).folder || ''));
    if (isPublishing()) return [409, { error: 'Wait for publishing to finish.' }];
    return [200, await adoptFromGitHub(f)];
  },
  // public or private, without counting as arranging the album
  'POST /api/album/visibility': async req => {
    const { folder, public: pub, groups, full, allowSensitive, geo } = await body(req);
    const f = path.resolve(String(folder || ''));
    if ((pub != null && typeof pub !== 'boolean') || (groups != null && !Array.isArray(groups)) || !db.prepare('SELECT 1 FROM folders WHERE path = ?').get(f)) return [400, { error: 'Bad request.' }];
    const row = db.prepare('SELECT data FROM albums WHERE folder = ?').get(f);
    const data = row ? JSON.parse(row.data) : { unsaved: true };
    if (pub != null) data.public = pub;
    if (typeof full === 'boolean') data.full = full;
    if (typeof geo === 'boolean') data.geo = geo;
    if (allowSensitive === true) data.allowSensitive = true; // the owner saw the sensitive-photo warning and chose to publish
    if (groups) data.groups = clean({ groups }, []).groups; // who may see it when private
    db.prepare('INSERT INTO albums (folder, data) VALUES (?, ?) ON CONFLICT(folder) DO UPDATE SET data = excluded.data').run(f, JSON.stringify(data));
    return [200, { public: pub, full }];
  },

  // ---- the local AI: describe photos, find people, search ----
  'GET /api/ai': async (req, url) => {
    const folder = path.resolve(url.searchParams.get('folder') || '');
    let ok = true, why = null;
    try { await ai.ready(); } catch (e) { ok = false; why = e.message; }
    return [200, { ok, why, model: ai.MODEL(), job: ai.aiJob(), queued: aiQueue.length, undescribed: ai.undescribed(folder).length }];
  },
  'POST /api/ai/describe': async req => { aiLater({ kind: 'describe', folder: path.resolve(String((await body(req)).folder || '')) }); return [202, { queued: true }]; },
  'POST /api/ai/find': async req => {
    const b = await body(req);
    aiLater({ kind: 'find', folder: path.resolve(String(b.folder || '')), tagId: Number(b.tagId) });
    return [202, { queued: true }];
  },
  'POST /api/ai/stop': () => { aiQueue.length = 0; ai.cancelAi(); return [200, {}]; },

  // ---- settings: the AI's model, and going over photos again ----
  'GET /api/settings': async () => {
    let models = [];
    try { // the vision models in Ollama: the only ones that can look at photos
      const list = (await fetch(`${setting('ollama', 'http://127.0.0.1:11434')}/api/tags`, { signal: AbortSignal.timeout(4000) }).then(r => r.json())).models || [];
      for (const m of list) {
        const show = await fetch(`${setting('ollama', 'http://127.0.0.1:11434')}/api/show`, { method: 'POST', body: JSON.stringify({ model: m.name }) }).then(r => r.json()).catch(() => ({}));
        if (show.capabilities?.includes('vision')) models.push({ name: m.name, size: m.size });
      }
    } catch {}
    return [200, { model: ai.MODEL(), models, upscale: upscale.status(), raw: raw.status(), denoiseRaw: setting('denoiseRaw') === 'yes' }];
  },
  'POST /api/settings': async req => {
    const b = await body(req);
    if (b.denoiseRaw != null) setSetting('denoiseRaw', b.denoiseRaw === true ? 'yes' : 'no');
    if (b.visionModel != null) { if (!/^[\w.:/-]{2,80}$/.test(String(b.visionModel))) return [400, { error: 'Bad model name.' }]; setSetting('visionModel', b.visionModel); }
    return [200, { model: ai.MODEL() }];
  },
  // check quality, read the files' details (dates, camera, place) or describe with the AI again: for some
  // photos or a whole shoot; the AI can be given instructions for this run
  'POST /api/reprocess': async req => {
    const b = await body(req), folder = path.resolve(String(b.folder || ''));
    if (!db.prepare('SELECT 1 FROM folders WHERE path = ?').get(folder)) return [400, { error: 'Import this shoot first.' }];
    const ids = b.ids == null ? db.prepare('SELECT id FROM photos WHERE folder = ?').all(folder).map(r => r.id) : ownIds(b.ids);
    if (!ids?.length) return [400, { error: 'No photos chosen.' }];
    const what = b.what || {}, note = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if ((what.details || what.check) && busy()) return [409, { error: 'Wait for the import or check that is running.' }];
    const marks = ids.map(() => '?').join(',');
    if (what.check) db.prepare(`DELETE FROM scores WHERE photo_id IN (${marks})`).run(...ids);
    if (what.details) { db.prepare(`UPDATE photos SET mtime = -1 WHERE id IN (${marks})`).run(...ids); runImport(folder); } // an import reads them again, then checks
    else if (what.check) runCheck(folder);
    if (what.describe) aiLater({ kind: 'describe', folder, ids, note });
    return [202, { photos: ids.length }];
  },

  // ---- the programs Lamhaat uses: found, started, installed (only when the owner clicks) ----
  'GET /api/tools': async () => [200, { tools: await tools.status() }],
  'POST /api/tools/install': async req => {
    const id = String((await body(req)).id || '');
    tools.install(id, p => send('tool', p)).then(() => send('tool', { id, finished: true }), e => send('tool', { id, error: e.message }));
    return [202, {}];
  },
  'POST /api/tools/ollama': async req => {
    const ok = (await body(req)).restart ? await tools.restartOllama() : await tools.startOllama();
    return ok ? [200, { running: true }] : [503, { error: 'The AI server (Ollama) won’t start. Restart the PC, or download it again.' }];
  },

  // ---- bigger or sharper photos: a new photo next to the original ----
  'GET /api/upscale': () => [200, { ...upscale.status(), job: upJob && { done: upJob.done, total: upJob.total } }],
  'POST /api/upscale/install': () => {
    upscale.install(throttled('upscale-install')).then(s => send('upscale-install', { ...s, finished: true })).catch(e => send('upscale-install', { error: e.message }));
    return [202, {}];
  },
  'POST /api/upscale': async req => {
    const b = await body(req), ids = ownIds(b.ids);
    if (!ids || !upscale.MODES[b.mode]) return [400, { error: 'Bad request.' }];
    if (upJob) return [409, { error: 'Already enhancing photos. One batch at a time.' }];
    const photos = db.prepare(`SELECT id, path, name, folder, w, h, taken, camera FROM photos WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    runUpscale(photos, b.mode, b.ai !== false && upscale.status().ai);
    return [202, { photos: photos.length }];
  },
  'POST /api/denoise': async req => {
    const ids = ownIds((await body(req)).ids);
    if (!ids) return [400, { error: 'Bad request.' }];
    if (!raw.status().denoise) return [400, { error: 'The AI noise removal needs ComfyUI’s Python on this PC for now (Settings → RAW photos and noise).' }];
    if (upJob) return [409, { error: 'Already working on photos. One batch at a time.' }];
    runDenoise(db.prepare(`SELECT id, path, name, folder, sha256 FROM photos WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids));
    return [202, { photos: ids.length }];
  },
  // a newer version is starting: step aside, unless something is still being worked on
  'POST /api/quit': () => {
    if (busy()) return [409, { error: 'Busy.' }];
    send('restart', {});
    setTimeout(() => process.exit(0), 300);
    return [200, {}];
  },
  // the recovery code for private albums' key: shown only in this window; restoring keeps the old keys beside
  'GET /api/keys': () => [200, { saved: setting('keysSaved', null) }],
  'POST /api/keys/code': () => [200, { code: recoveryCode() }],
  'POST /api/keys/saved': () => { setSetting('keysSaved', new Date().toISOString()); return [200, {}]; },
  'POST /api/keys/restore': async req => {
    try { restoreKeys((await body(req)).code); } catch (e) { return [400, { error: e.message }]; }
    setSetting('keysSaved', new Date().toISOString());
    return [200, { restored: true }];
  },
  // search by meaning: the window works out what is missing, and hands the numbers back
  'GET /api/embeds': (req, url) => [200, { todo: embeds.todo(path.resolve(url.searchParams.get('folder') || '')) }],
  'POST /api/embeds': async req => { const b = await body(req); return [200, { saved: embeds.save(Array.isArray(b.items) ? b.items : []) }]; },
  'POST /api/reveal': async req => { // the photo's file, selected in File Explorer
    const id = ownIds([(await body(req)).id])?.[0], p = id && db.prepare('SELECT path FROM photos WHERE id = ?').get(id)?.path;
    if (!p) return [400, { error: 'Bad photo.' }];
    spawn('explorer.exe', [`/select,${p}`], { detached: true, stdio: 'ignore' }).unref();
    return [200, {}];
  },

  // ---- people you share private albums with, and private viewing online ----
  'GET /api/people': () => [200, { people: people.people(), groups: people.groupList() }],
  'POST /api/people': async req => {
    try { people.savePerson(await body(req)); } catch (e) { return [400, { error: e.message }]; }
    return [200, { people: people.people(), groups: people.groupList(), synced: await syncQuietly() }];
  },
  'POST /api/people/remove': async req => {
    people.removePerson((await body(req)).email);
    return [200, { people: people.people(), groups: people.groupList(), synced: await syncQuietly() }];
  },
  // ---- private albums with Google sign-in (Firebase) ----
  'GET /api/firebase': () => { const st = firebase.status(); return [200, { ...st, rules: firebase.rulesFor(st.owner) }]; },
  'POST /api/firebase/details': async req => [200, firebase.saveDetails(await body(req))],
  'POST /api/firebase/signin': async req => [200, await firebase.ownerSignIn((await body(req)).refreshToken)],
  // a one-time link for signing in from any browser; opened in the default one when asked
  'POST /api/firebase/browser': async req => {
    if (!firebase.status().config) return [400, { error: 'Paste the Firebase settings first.' }];
    fbSign = { state: crypto.randomBytes(18).toString('hex'), exp: Date.now() + 20 * 60e3 };
    const link = `http://localhost:${PORT}/firebase/signin?s=${fbSign.state}`; // localhost: Firebase trusts it
    if ((await body(req)).open) spawn('rundll32.exe', ['url.dll,FileProtocolHandler', link], { detached: true, stdio: 'ignore' }).unref();
    return [200, { link }];
  },
  // people who asked for access on the site
  'GET /api/requests': async () => [200, { requests: await firebase.requests().catch(() => []) }],
  'POST /api/requests/dismiss': async req => { await firebase.dismissRequest((await body(req)).email); return [200, {}]; },
  'POST /api/firebase/signout': () => { firebase.ownerSignOut(); return [200, firebase.status()]; },
  // proves the database and rules work, writes the people list, then puts the sign-in button on the site
  'POST /api/firebase/connect': async () => {
    await firebase.check();
    const r = await firebase.syncAccess();
    if (busy()) return [200, { ...r, site: 'later' }];
    publishSite(d => send('fbsite', { detail: d }))
      .then(done => send('fbsite', { done }))
      .catch(e => send('fbsite', { error: e.message }))
      .finally(maybeQuit);
    return [200, { ...r, site: 'publishing' }];
  },

  // ---- GitHub: sign in (browser code, the GitHub CLI's sign-in, or a token), sign out ----
  'GET /api/github': (req, url) => {
    const host = github.cleanHost(url.searchParams.get('host'));
    return [200, { account: github.publicAccount(github.current()), ready: github.appReady(host), callback: `http://${HOST}:5190/github/callback`, pending: pendingSignIn && { userCode: pendingSignIn.userCode, url: pendingSignIn.url, expiresAt: pendingSignIn.expiresAt } }];
  },
  'POST /api/github/browser': async req => {
    const host = github.cleanHost((await body(req)).host);
    if (pendingSignIn) pendingSignIn.cancelled = true;
    const start = await github.deviceStart(host);
    const mine = pendingSignIn = { ...start, cancelled: false };
    github.deviceWait(start, () => mine.cancelled)
      .then(acc => send('github', { account: github.publicAccount(acc) }))
      .catch(e => { if (e.kind !== 'cancelled') send('github', { error: e.message, kind: e.kind }); })
      .finally(() => { if (pendingSignIn === mine) pendingSignIn = null; });
    return [200, { userCode: start.userCode, url: start.url, expiresAt: start.expiresAt }];
  },
  'POST /api/github/web': async req => [200, { url: github.webStart(github.cleanHost((await body(req)).host), callback()) }],
  'POST /api/github/cancel': () => { if (pendingSignIn) pendingSignIn.cancelled = true; pendingSignIn = null; return [200, {}]; },
  'POST /api/github/cli': async req => [200, { account: github.publicAccount(await github.fromCli(github.cleanHost((await body(req)).host))) }],
  'POST /api/github/token': async req => { const b = await body(req); return [200, { account: github.publicAccount(await github.fromToken(github.cleanHost(b.host), b.token)) }]; },
  'POST /api/github/app-id': async req => {
    const b = await body(req);
    if (!/^[\w.]{8,64}$/.test(String(b.clientId || '').trim())) return [400, { error: 'That doesn’t look like an app’s Client ID.' }];
    if (b.clientSecret && !/^[\w]{20,128}$/.test(String(b.clientSecret).trim())) return [400, { error: 'That doesn’t look like a Client secret.' }];
    github.setApp(github.cleanHost(b.host), String(b.clientId).trim(), b.clientSecret && String(b.clientSecret).trim());
    return [200, {}];
  },
  'POST /api/github/signout': async () => { if (isPublishing()) return [409, { error: 'Wait for the upload to finish or stop it first.' }]; return [200, await github.signOut()]; },
  'POST /api/github/make-private': async req => {
    const { repo } = await body(req), acc = github.current();
    if (!acc || !/^lamha-(a-[a-z0-9]{10}-media(-part\d+)?|catalog)$/.test(String(repo))) return [400, { error: 'Bad request.' }];
    await github.api(acc, 'PATCH', `/repos/${acc.login}/${repo}`, { private: true });
    return [200, {}];
  },

  // ---- publishing one album ----
  'GET /api/publish': (req, url) => [200, { run: lastRun(path.resolve(url.searchParams.get('folder') || '')), active: isPublishing() }],
  'POST /api/publish': async req => {
    const f = path.resolve(String((await body(req)).folder || ''));
    if (!db.prepare('SELECT 1 FROM folders WHERE path = ?').get(f)) return [400, { error: 'Import this shoot first.' }];
    if (busy()) return [409, { error: isPublishing() ? 'Another album is publishing. One at a time.' : 'Wait for the import or check to finish.' }];
    let last = 0;
    publish(f, run => { const now = Date.now(); if (now - last > 250 || run.status !== 'running') { last = now; send('publish', run); } })
      .catch(e => send('publish', { folder: f, status: 'failed', error: { kind: e.kind || 'other', message: e.message } }))
      .finally(maybeQuit);
    return [202, { started: true }];
  },
  'POST /api/publish/cancel': () => { cancelPublish(); return [200, {}]; },
  // deleted photos out of GitHub's history for good
  'POST /api/purge': async req => {
    const f = path.resolve(String((await body(req)).folder || ''));
    if (busy()) return [409, { error: 'Wait for what is running to finish.' }];
    purgeAlbum(f, d => send('purge', { folder: f, detail: d })).then(r => send('purge', { folder: f, done: r.removed })).catch(e => send('purge', { folder: f, error: e.message })).finally(maybeQuit);
    return [202, {}];
  },
  // "Lock again": every private album on GitHub gets a new key and is sealed anew, one after another, so
  // keys anyone saved before (someone just removed, say) open nothing any more
  'POST /api/albums/relock': () => {
    if (busy()) return [409, { error: 'Wait for the import, check or upload that is running.' }];
    const rows = db.prepare('SELECT folder, data FROM albums').all().map(r => ({ folder: r.folder, d: JSON.parse(r.data) })).filter(r => r.d.id && !r.d.public && fs.existsSync(r.folder));
    if (!rows.length) return [200, { albums: 0 }];
    for (const r of rows) { r.d.keyEpoch = (r.d.keyEpoch || 0) + 1; db.prepare('UPDATE albums SET data = ? WHERE folder = ?').run(JSON.stringify(r.d), r.folder); }
    (async () => {
      let done = 0;
      for (const r of rows) {
        const run = await publish(r.folder, run => send('publish', run)).catch(e => ({ status: 'failed', error: { message: e.message } }));
        send('relock', { done: ++done, total: rows.length, album: path.basename(r.folder), status: run.status, error: run.error?.message });
        if (run.status !== 'done') break; // the rest wait; pressing it again carries on
      }
      maybeQuit();
    })();
    return [202, { albums: rows.length }];
  },
  'PUT /api/album': async req => {
    const { folder, album } = await body(req);
    const f = path.resolve(String(folder || ''));
    if (!db.prepare('SELECT 1 FROM folders WHERE path = ?').get(f)) return [400, { error: 'Import this shoot first.' }];
    if (!album || typeof album !== 'object') return [400, { error: 'Bad album.' }];
    const tidy = clean(album, inAlbum(db.prepare('SELECT id, name, taken, decision FROM photos WHERE folder = ?').all(f)));
    db.prepare('INSERT INTO albums (folder, data) VALUES (?, ?) ON CONFLICT(folder) DO UPDATE SET data = excluded.data').run(f, JSON.stringify(tidy));
    return [200, { album: tidy }];
  },
  'POST /api/check': async req => {
    const folder = path.resolve(String((await body(req)).folder || ''));
    if (!db.prepare('SELECT 1 FROM folders WHERE path = ?').get(folder)) return [400, { error: 'Import this shoot first.' }];
    if (busy()) return [409, { error: 'Another import or check is running.' }];
    runCheck(folder);
    return [202, { started: true }];
  },
};

// the page the browser opens for Google sign-in: Firebase's own sign-in, then the renewal key to Lamhaat
let fbSign = null; // { state, exp }
const fbSignPage = (config, state) => `<!doctype html><meta charset="utf-8"><title>Lamhaat · Sign in with Google</title><meta name="viewport" content="width=device-width">
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#111110;color:#edebe5;font:16px/1.5 system-ui,sans-serif;text-align:center">
<div style="max-width:440px;padding:24px"><p style="font:400 2.2rem Georgia,serif;margin:0 0 8px">Lamhaat</p>
<p id="msg" style="color:#b4b1a8">Sign in with the Google account that owns your albums.</p>
<button id="go" style="font:600 1rem system-ui;padding:12px 22px;border:0;border-radius:999px;background:#ee7a43;color:#fff;cursor:pointer">Sign in with Google</button></div>
<script type="module">
const cfg = ${JSON.stringify(config).replace(/</g, '\\u003c')}, s = ${JSON.stringify(state)}, SDK = 'https://www.gstatic.com/firebasejs/13.0.0';
const msg = document.getElementById('msg'), go = document.getElementById('go');
const say = (t, ok) => { msg.textContent = t; msg.style.color = ok ? '#7fbf8e' : '#e86a5a'; };
const why = { 'auth/operation-not-allowed': 'Google sign-in isn’t switched on in this Firebase project (Authentication → Sign-in method → Google → Enable).',
  'auth/unauthorized-domain': 'Firebase doesn’t allow this page. In Authentication → Settings → Authorized domains, keep “localhost” in the list.' };
go.onclick = async () => {
  go.disabled = true;
  try {
    const [{ initializeApp }, auth] = await Promise.all([import(SDK + '/firebase-app.js'), import(SDK + '/firebase-auth.js')]);
    const a = auth.getAuth(initializeApp(cfg)), p = new auth.GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    const c = await auth.signInWithPopup(a, p);
    const r = await fetch('/firebase/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ s, refreshToken: c.user.refreshToken }) });
    const d = await r.json();
    await auth.signOut(a); // Lamhaat keeps its own copy, encrypted; this browser keeps nothing
    if (!r.ok) throw new Error(d.error);
    say('✓ Signed in as ' + d.owner + '. You can close this tab and go back to Lamhaat.', true); go.remove();
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') { go.disabled = false; return; }
    say(why[e.code] || e.message || 'Sign-in didn’t finish.'); go.disabled = false;
  }
};
</script>`;

// ---- serving ----
const server = http.createServer(async (req, res) => {
  try {
    // only this machine, by its own name: blocks DNS-rebinding tricks from other websites
    if (req.headers.host !== `${HOST}:${PORT}` && req.headers.host !== `localhost:${PORT}`) return res.writeHead(403).end();
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname === '/' && url.searchParams.get('k') === key) {
      // the window opens with the key once; from then on it rides in a strict, http-only cookie
      res.writeHead(302, { location: '/', 'set-cookie': `k=${key}; HttpOnly; SameSite=Strict; Path=/` });
      return res.end();
    }
    // GitHub sends the person's own browser back here after they approve Lamhaat. That browser has no
    // session cookie; the one-time state from webStart is what proves the request is ours.
    if (url.pathname === '/github/callback') {
      let ok = true, text;
      try { const acc = await github.webFinish(url.searchParams); text = `Signed in as ${acc.login}.`; send('github', { account: github.publicAccount(acc) }); }
      catch (e) { ok = false; text = e instanceof github.Problem ? e.message : 'Sign-in failed.'; send('github', { error: text, kind: e.kind }); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>Lamhaat</title><meta name="viewport" content="width=device-width">
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#111110;color:#edebe5;font:16px/1.5 system-ui,sans-serif;text-align:center">
<div><p style="font:400 2.4rem Georgia,serif;margin:0 0 8px">${ok ? '✓' : '✕'} ${text.replace(/[<>&]/g, '')}</p>
<p style="color:#b4b1a8">${ok ? 'You can close this tab and go back to Lamhaat.' : 'Close this tab and try again from Lamhaat.'}</p></div>`);
    }
    // Google sign-in for Firebase, in the person's own browser (where they are usually signed in to Google
    // already). Like the GitHub callback, that browser has no session cookie: the one-time state proves it.
    if (url.pathname === '/firebase/signin') {
      const s = req.method === 'POST' ? await body(req).catch(() => ({})) : { s: url.searchParams.get('s') };
      const valid = fbSign && fbSign.exp > Date.now() && typeof s.s === 'string' && s.s.length === fbSign.state.length && crypto.timingSafeEqual(Buffer.from(s.s), Buffer.from(fbSign.state));
      if (req.method === 'POST') {
        if (!valid) return json(res, 400, { error: 'This sign-in link has expired. Start again from Lamhaat.' });
        try { const st = await firebase.ownerSignIn(s.refreshToken); fbSign = null; send('fbsignin', { owner: st.owner }); return json(res, 200, { owner: st.owner }); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      res.writeHead(valid ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      return res.end(valid ? fbSignPage(firebase.status().config, s.s) : '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">This sign-in link has expired. Start again from Lamhaat (People &amp; sharing).');
    }
    const cookie = /(?:^|;\s*)k=([0-9a-f]+)/.exec(req.headers.cookie || '')?.[1];
    if (!cookie || cookie.length !== key.length || !crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(key))) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      return res.end('Open Lamhaat from its shortcut.');
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hello\n\n');
      clients.add(res); everConnected = true; clearTimeout(quitTimer);
      req.on('close', () => { clients.delete(res); maybeQuit(); });
      return;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      try { const [code, data] = await route(req, url); return json(res, code, data); }
      catch (e) { if (e instanceof github.Problem) return json(res, 400, { error: e.message, kind: e.kind }); throw e; }
    }

    const pv = /^\/preview\/([0-9a-f]{64})\.jpg$/.exec(url.pathname);
    if (pv) {
      return fs.createReadStream(previewPath(pv[1]))
        .on('error', () => res.writeHead(404).end())
        .once('open', () => res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' }))
        .pipe(res);
    }
    // a photo at full quality for the large view: up to 3200 px, made once from the original and kept
    const full = /^\/full\/([0-9a-f]{64})\.jpg$/.exec(url.pathname);
    if (full) {
      try {
        const file = await fullSize(full[1]);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' });
        return fs.createReadStream(file).pipe(res);
      } catch { return res.writeHead(404).end(); }
    }
    // a photo with its edits, thumbnail size; named by its edits so a new edit is a new file
    const ed = /^\/edited\/(\d+)-([0-9a-f]{10})\.jpg$/.exec(url.pathname);
    if (ed) {
      try {
        const row = db.prepare('SELECT p.path, p.sha256, m.edits FROM photos p JOIN photo_meta m ON m.photo_id = p.id WHERE p.id = ?').get(Number(ed[1]));
        if (!row?.edits) return res.writeHead(404).end();
        const out = path.join(dataDir, 'previews', 'edited', `${row.sha256}-${ed[2]}.jpg`);
        if (!fs.existsSync(out)) {
          fs.mkdirSync(path.dirname(out), { recursive: true });
          await (await edited(row.path, JSON.parse(row.edits), 720)).jpeg({ quality: 82, mozjpeg: true }).toFile(`${out}.part`);
          fs.renameSync(`${out}.part`, out);
        }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' });
        return fs.createReadStream(out).pipe(res);
      } catch { return res.writeHead(404).end(); }
    }
    // the album rules are shared with the window, so both sides split chapters the same way
    // and search by meaning, shared with the site (so both work out a photo's numbers the same way)
    const shared = /^\/lib\/(album|edit)\.js$/.test(url.pathname) ? path.join(import.meta.dirname, url.pathname.slice(5))
      : /^\/lib\/(meaning\.js|vendor\/minilm-vocab\.txt)$/.test(url.pathname) ? path.join(import.meta.dirname, '..', 'site', url.pathname.slice(5)) : null;
    const file = shared || path.join(UI, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!(file.startsWith(UI) || shared) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

// this version of the app: its files as they were when it started (a changed file is a new version)
const VERSION = crypto.createHash('sha1').update(fs.readdirSync(import.meta.dirname, { recursive: true }).filter(f => /\.(js|mjs|py|css|html)$/.test(f)).sort()
  .map(f => { const st = fs.statSync(path.join(import.meta.dirname, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join('|')).digest('hex').slice(0, 12);
let swapped = false;
server.on('error', async err => {
  if (err.code !== 'EADDRINUSE') throw err;
  // Lamhaat already running there: open another window onto it. Another program: use the next port.
  let s = null;
  try { s = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch {}
  const ours = (s?.port ?? 5190) === PORT && await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(3000) }).then(r => r.text()).then(t => t.includes('Lamhaat')).catch(() => false);
  // an older version of Lamhaat is still running (it was updated since): if it is idle, it steps aside for this one
  if (ours && s.version !== VERSION && !swapped) {
    swapped = true;
    const ok = await fetch(`http://${HOST}:${PORT}/api/quit`, { method: 'POST', headers: { cookie: `k=${s.key}` }, signal: AbortSignal.timeout(5000) }).then(r => r.ok).catch(() => false);
    if (ok) { for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 300)); if (!(await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false))) break; } return server.listen(PORT, HOST); }
  }
  if (ours) { openWindow(s.key); return setTimeout(() => process.exit(0), 500); }
  if (PORT >= 5210) { console.error('No free port between 5190 and 5210.'); return process.exit(1); }
  PORT++;
  server.listen(PORT, HOST);
});
server.listen(PORT, HOST, () => {
  fs.writeFileSync(sessionFile, JSON.stringify({ key, pid: process.pid, port: PORT, version: VERSION }));
  console.log(`Lamhaat is running on http://${HOST}:${PORT}`);
  if (!process.argv.includes('--no-window')) openWindow(key);
  if (!process.env.LAMHAAT_NO_OLLAMA) tools.startOllama().catch(() => {}); // the AI server runs whenever the app does
});
