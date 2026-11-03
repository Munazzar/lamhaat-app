// The publishing agent (spec section 5): puts one album on GitHub the way the first albums were set up
// by hand, step by step, checking each one:
//   1. ready?    git present, signed in, review finished, keys there
//   2. find      is this album already on GitHub? (its id, or the same photos in the catalog)
//   3. copies    web-size copies of new photos only (thumb / md / full AVIF, metadata stripped)
//   3b. full     full-size JPEGs for the large view, in public repos lamha-full-N (no GPS or camera data)
//   4. photos    private repo lamha-a-<id>-media: new files in batches, the manifest last
//   5. shell     public repo lamha-a-<id>: only an opaque id, never titles, dates or photos
//   6. catalog   private repo lamha-catalog: the album is listed last, so a half-done upload never shows
//   7. site      public albums only: the lamhaat site repo, GitHub Pages on, and a check it is live
// Every step can run again safely: it looks at what GitHub already has and only does what is missing.
// So recovering is always the same move: run again. Network trouble and GitHub's slow-down requests
// are waited out automatically; anything that needs the person stops with what happened and what fixes it.
import { spawn } from 'node:child_process';
import { gitPath } from './tools.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { encode as blurhash } from 'blurhash';
import { db, dataDir, setting, setSetting } from './db.js';
import { inAlbum, clean, defaultAlbum, assign } from './album.js';
import { aiFor } from './ai.js';
import { forPublish as embedsFor } from './embeds.js';
import { RAW, readable } from './raw.js';
import { metaFor, allTags, setText, tagPhotos } from './meta.js';
import { tidy } from './edit.js';
import { edited } from './render.js';
import * as firebase from './firebase.js';
import { api, fresh, check, gitEnv, urls, Problem } from './github.js';
import { loadKeys } from '../scripts/keys.js';

const STAGE = path.join(dataDir, 'staging');
const SITE = path.join(import.meta.dirname, '..', 'site');
const VARIANTS = { thumb: 400, sm: 800, md: 1600, full: 3000 }; // sm: a phone's grid (added later: photos already up just get it)
// how the copies are encoded; a photo published with an older way is made again on the next publish
// (2: quality 72 with full colour detail for md and full; 1 was quality 55, which smoothed fine texture away)
const ENC = 2;
const AVIF = name => name === 'thumb' ? { quality: 50, effort: 4 } : name === 'sm' ? { quality: 62, effort: 4 } : { quality: 72, effort: 4, chromaSubsampling: '4:4:4' };
const BATCH = 300e6, MAX_FILE = 25 * 2 ** 20; // GitHub: small pushes, at most about one a minute
const ROLL = () => Number(process.env.LAMHAAT_ROLL_BYTES || 3.5e9); // an album's repository is filled to this, then the next one starts (a small number only in tests)
// Full-size copies, for the large view: the photo at its own size, as JPEG quality 95 with full colour
// detail and its colour profile, but none of the camera's hidden details (no GPS). Too big for one site
// (GitHub Pages sites are kept under 1 GB), they go to public repositories of their own, lamha-full-1, -2…,
// each its own small Pages site at the same address, filled to about 900 MB each.
const FULL_REPO_LIMIT = 900e6, FULL_MAX_FILE = 95e6, FULLQ = 1;
const PUSH_GAP = Number(process.env.LAMHAAT_PUSH_GAP_MS ?? 60e3); // shorter only in tests, against the stand-in GitHub
const CATALOG = 'lamha-catalog', SITE_REPO = 'lamhaat';
const STEPS = [['ready', 'Check everything is ready'], ['find', 'Find the album on GitHub'], ['copies', 'Make web-size copies'],
  ['full', 'Full-size copies (for the large view)'], ['photos', 'Upload photos (private)'], ['shell', 'Album placeholder (public, no photos)'], ['catalog', 'Add to your catalog (private)'], ['site', 'Update the site'], ['share', 'Share with your people (Firebase)']];

db.exec('CREATE TABLE IF NOT EXISTS publish_runs (folder TEXT PRIMARY KEY, data TEXT NOT NULL)');
// a run that was going when the app closed can simply be run again
for (const r of db.prepare('SELECT folder, data FROM publish_runs').all()) {
  const d = JSON.parse(r.data);
  if (d.status === 'running') { d.status = 'interrupted'; for (const s of d.steps) if (s.status === 'running') s.status = 'failed'; d.error = { kind: 'interrupted', message: 'Lamhaat closed while this was publishing. Nothing is lost: run it again and it carries on.' }; saveRun(r.folder, d); }
}
function saveRun(folder, run) { db.prepare('INSERT INTO publish_runs (folder, data) VALUES (?, ?) ON CONFLICT(folder) DO UPDATE SET data = excluded.data').run(folder, JSON.stringify(run)); }
export const lastRun = folder => { const r = db.prepare('SELECT data FROM publish_runs WHERE folder = ?').get(folder); return r ? JSON.parse(r.data) : null; };

let active = null; // { folder, cancel }
export const isPublishing = () => active?.folder || null;
export const cancelPublish = () => { if (active) active.cancel = true; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- git, quietly and with the sign-in attached ----------
function git(cwd, args, env, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(gitPath(), ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=off', '-c', 'advice.detachedHead=false', ...args], { cwd, env, windowsHide: true });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => err.push(d));
    p.on('error', e => reject(e.code === 'ENOENT' ? new Problem('nogit', 'Git isn’t installed. Settings → Programs Lamhaat uses → Git: Download it, then run again.') : e));
    p.on('close', code => {
      const o = Buffer.concat(out);
      if (code === 0) return resolve(raw ? o : o.toString());
      reject(gitProblem(Buffer.concat(err).toString() || o.toString()));
    });
  });
}
function gitProblem(text) {
  const t = text.replace(/AUTHORIZATION:[^\n]*/gi, '').trim(); // never echo the sign-in
  if (/could not resolve host|unable to access|timed out|connection (reset|refused)|early eof|remote end hung up|network/i.test(t)) return new Problem('offline', 'The connection to GitHub dropped.');
  if (/authentication failed|invalid username|401/i.test(t)) return new Problem('signin', 'GitHub no longer accepts this sign-in. Sign in again.');
  if (/permission to .* denied|403|write access/i.test(t)) return new Problem('scope', 'GitHub refused to let this sign-in write to the repository. Sign in again and allow repository access.');
  if (/\[rejected\]|fetch first|non-fast-forward|stale info/i.test(t)) return new Problem('moved', 'The repository changed on GitHub while we were working.');
  if (/no space left|disk full/i.test(t)) return new Problem('disk', `The disk is full. Free some space on the drive with ${dataDir}, then run again.`);
  if (/GH001|exceeds|too large/i.test(t)) return new Problem('toobig', `GitHub refused a file as too large: ${t.split('\n').pop()}`);
  return new Problem('git', `Git failed: ${t.split('\n').slice(-3).join(' ')}`);
}

// ---------- repositories ----------
async function ensureRepo(ctx, name, visibility) {
  let repo;
  try { repo = await api(ctx.auth, 'GET', `/repos/${ctx.owner}/${name}`); }
  catch (e) {
    if (e.kind !== 'notfound') throw e;
    repo = await api(ctx.auth, 'POST', '/user/repos', { name, private: visibility === 'private', has_wiki: false, has_issues: false, has_projects: false, auto_init: false });
    ctx.log(`Created ${visibility} repository ${name}`);
  }
  if (visibility === 'private' && !repo.private) throw new Problem('public-repo', `${name} is public on GitHub but must be private.`, { repo: name });
  return repo;
}
// a light local copy: the history's tip and file list, without downloading any photos back
async function workingCopy(ctx, name) {
  const dir = path.join(STAGE, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) await git(dir, ['init', '-q', '-b', 'main'], ctx.env);
  await git(dir, ['remote', 'remove', 'origin'], ctx.env).catch(() => {});
  await git(dir, ['remote', 'add', 'origin', `${urls(ctx.auth.host).web}/${ctx.owner}/${name}.git`], ctx.env);
  await git(dir, ['config', 'user.name', ctx.owner], ctx.env);
  await git(dir, ['config', 'user.email', `${ctx.owner}@users.noreply.${ctx.auth.host === 'github.com' ? 'github.com' : ctx.auth.host}`], ctx.env);
  const remote = (await git(dir, ['ls-remote', 'origin', 'refs/heads/main'], ctx.env)).split(/\s/)[0];
  if (remote) {
    await git(dir, ['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', 'main'], ctx.env);
    await git(dir, ['reset', '-q', 'FETCH_HEAD'], ctx.env); // index = GitHub's files; nothing downloaded
  } else {
    await git(dir, ['read-tree', '--empty'], ctx.env).catch(() => {}); // a new, empty repository
  }
  // every file GitHub has, with its content's id (git blob), so a file changed under the same name is noticed
  const blob = new Map((await git(dir, ['ls-files', '-s', '-z'], ctx.env)).split('\0').filter(Boolean).map(l => { const [meta, file] = l.split('\t'); return [file, meta.split(' ')[1]]; }));
  return { dir, has: new Set(blob.keys()), blob };
}
const read = (ctx, dir, file) => git(dir, ['cat-file', 'blob', `HEAD:${file}`], ctx.env, { raw: true }); // fetched on demand
async function push(ctx, dir, what) {
  const wait = ctx.lastPush + PUSH_GAP - Date.now();
  if (wait > 0) { ctx.detail(`Waiting ${Math.ceil(wait / 1000)} s between uploads (GitHub’s pace)`); await sleep(wait); }
  ctx.detail(`Uploading ${what}…`);
  await git(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main'], ctx.env);
  ctx.lastPush = Date.now();
  // check: GitHub now has exactly what we have
  const [local, remote] = await Promise.all([git(dir, ['rev-parse', 'HEAD'], ctx.env), git(dir, ['ls-remote', 'origin', 'refs/heads/main'], ctx.env)]);
  if (local.trim() !== remote.split(/\s/)[0]) throw new Problem('moved', 'GitHub doesn’t show the upload yet.');
}
async function commit(ctx, dir, message) {
  if (!(await git(dir, ['diff', '--cached', '--name-only'], ctx.env)).trim()) return false;
  await git(dir, ['commit', '-q', '--no-verify', '-m', message], ctx.env);
  return true;
}

// ---------- copies and ids ----------
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const blobSha = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
// each private album is sealed with its own key (firebase.albumKey), which is what its viewers get
const seal = (key, buf) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()]); };
const open = (key, buf) => { const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12)); d.setAuthTag(buf.subarray(-16)); return Buffer.concat([d.update(buf.subarray(12, -16)), d.final()]); };
// an album's key now, and the ones it had before "Lock again" (files not re-sealed yet), then the library key (older albums)
const epochFor = id => { for (const r of db.prepare('SELECT data FROM albums').all()) { const d = JSON.parse(r.data); if (d.id === id) return d.keyEpoch || 0; } return 0; };
const unseal = (keys, id, buf) => {
  for (let e = epochFor(id); e >= 0; e--) { try { return open(firebase.albumKey(keys, id, e), buf); } catch {} }
  return open(keys.enc, buf);
};
const photoId = (keys, sha) => crypto.createHmac('sha256', keys.hmac).update(sha).digest('hex').slice(0, 32);
const newId = () => Array.from(crypto.randomBytes(10), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
async function manifestOf(ctx, repo, encrypted, id) {
  try {
    const f = await api(ctx.auth, 'GET', `/repos/${ctx.owner}/${repo}/contents/manifest.json`);
    let buf = Buffer.from(f.content || '', 'base64');
    if (!f.content && f.git_url) buf = Buffer.from((await api(ctx.auth, 'GET', new URL(f.git_url).pathname.replace(/^\/api\/v3/, ''))).content, 'base64'); // over 1 MB
    return JSON.parse((encrypted ? unseal(ctx.keys, id, buf) : buf).toString());
  } catch (e) { if (e.kind === 'notfound') return null; if (e instanceof Problem) throw e; throw new Problem('manifest', `The album list on GitHub (${repo}/manifest.json) can’t be read: ${e.message}`); }
}

// ---------- the run ----------
export async function publish(folder, onUpdate = () => {}) {
  if (active) throw new Problem('busy', 'Another album is publishing. One at a time.');
  const run = { folder, status: 'running', startedAt: new Date().toISOString(), steps: STEPS.map(([id, label]) => ({ id, label, status: 'waiting' })), log: [] };
  active = { folder, cancel: false };
  const emit = () => { saveRun(folder, run); onUpdate(run); };
  const ctx = {
    lastPush: 0,
    log: text => { run.log.push({ at: new Date().toISOString(), text }); if (run.log.length > 200) run.log.shift(); emit(); },
    detail: text => { const s = run.steps.find(x => x.status === 'running'); if (s) s.detail = text; if (active.cancel) throw new Problem('cancelled', 'Stopped. Run again any time to carry on.'); emit(); },
  };
  emit();
  try {
    for (const step of run.steps) {
      step.status = 'running'; step.detail = ''; emit();
      for (let attempt = 1; ; attempt++) {
        try { step.result = await STEP[step.id](ctx, folder) ?? undefined; break; }
        catch (e) {
          const p = e instanceof Problem ? e : new Problem('other', String(e.message || e));
          // waited out on our own: dropped connections, GitHub busy or asking us to slow down, a repository that moved under us
          const auto = { offline: [30e3, 90e3, 180e3], server: [30e3, 90e3, 180e3], moved: [5e3, 5e3], rate: [p.waitMs, p.waitMs] }[p.kind];
          if (!auto || attempt > auto.length || active.cancel) throw p;
          const wait = auto[attempt - 1];
          ctx.log(`${p.message} Trying again in ${Math.round(wait / 1000)} s (attempt ${attempt + 1}).`);
          for (let t = wait; t > 0; t -= 1000) { ctx.detail(`${p.message} Trying again in ${Math.ceil(t / 1000)} s`); await sleep(Math.min(1000, t)); }
        }
      }
      step.status = step.result === 'skipped' ? 'skipped' : 'done'; step.detail = ctx.done || ''; ctx.done = '';
      emit();
    }
    run.status = 'done'; run.url = ctx.url || null; run.summary = ctx.summary;
  } catch (e) {
    const s = run.steps.find(x => x.status === 'running');
    if (s) s.status = e.kind === 'cancelled' ? 'waiting' : 'failed';
    run.status = e.kind === 'cancelled' ? 'cancelled' : 'failed';
    run.error = { kind: e.kind || 'other', message: e.message, url: e.url, repo: e.repo };
  } finally {
    run.endedAt = new Date().toISOString();
    active = null;
    emit();
  }
  return run;
}

const STEP = {
  async share(ctx) {
    const entry = ctx.catalog.albums.find(a => a.id === ctx.id);
    if (!firebase.isOn()) { ctx.done = ctx.album.public ? 'Public: nothing to share' : 'Sharing isn’t set up yet (People & sharing)'; return 'skipped'; }
    if (ctx.album.public || !entry?.encrypted) {
      if (JSON.parse(setting('sharedAlbums', '{}'))[ctx.id]) await firebase.unshareAlbum(ctx.id); // made public: no longer a private share
      ctx.done = 'Public: everyone can see it'; return 'skipped';
    }
    const r = await firebase.shareAlbum(entry, ctx.akey);
    const who = entry.groups.filter(g => g !== 'owner');
    ctx.done = who.length ? `Shared with ${who.map(g => g === 'everyone' ? 'anyone signed in' : g).join(', ')} · ${r.people} ${r.people === 1 ? 'person' : 'people'} on your list` : 'Only you can see it (choose groups on the Publish tab)';
  },
  async ready(ctx, folder) {
    await git(dataDir, ['--version'], process.env);
    const auth = await fresh();
    if (!auth) throw new Problem('signin', 'Sign in to GitHub first.');
    ctx.auth = auth; ctx.env = gitEnv(auth);
    ctx.owner = (await check(auth)).login;
    const rows = db.prepare('SELECT id, path, name, sha256, w, h AS hgtPx, taken, camera, lens, iso, shutter, f, decision, lat, lon FROM photos WHERE folder = ?').all(folder);
    const open = rows.filter(p => p.decision === 'undecided').length;
    if (!rows.length) throw new Problem('empty', 'This shoot has no photos. Import it first.');
    if (open) throw new Problem('review', `${open} photo${open === 1 ? ' is' : 's are'} not reviewed yet. Finish the review first: nothing is published until every photo is kept or rejected.`);
    ctx.photos = inAlbum(rows);
    // what was added here: titles, descriptions, tags and people, edits (named by a short fingerprint)
    const meta = metaFor(ctx.photos.map(p => p.id)), seen = aiFor(ctx.photos.map(p => p.id));
    ctx.emb = embedsFor(ctx.photos.map(p => p.id)); // search by meaning: each photo's numbers, if worked out for its words
    ctx.tagInfo = new Map(allTags().map(t => [t.id, t]));
    for (const p of ctx.photos) {
      const m = meta.get(p.id);
      Object.assign(p, { title: m.title, description: m.description, tags: m.tags, edits: tidy(m.edits), aiTags: seen.get(p.id)?.aiTags || [], aiDescription: seen.get(p.id)?.aiDescription || '' }); // the AI's words: chapters by scene, and search on the site
      p.ehash = p.edits ? crypto.createHash('sha1').update(JSON.stringify(p.edits)).digest('hex').slice(0, 10) : null;
    }
    if (!ctx.photos.length) throw new Problem('empty', 'Every photo in this shoot is rejected, so there is nothing to publish.');
    const row = db.prepare('SELECT data FROM albums WHERE folder = ?').get(folder);
    const stored = row ? JSON.parse(row.data) : null;
    ctx.albumSaved = !!stored && !stored.unsaved; // only an album arranged here replaces titles and chapters already on GitHub
    ctx.album = clean(ctx.albumSaved ? stored : { ...defaultAlbum(path.basename(folder), ctx.photos), id: stored?.id, public: stored?.public, groups: stored?.groups }, ctx.photos);
    ctx.publicChosen = typeof stored?.public === 'boolean';
    ctx.keys = loadKeys();
    for (const p of ctx.photos) { p.h = photoId(ctx.keys, p.sha256); if (!fs.existsSync(p.path)) throw new Problem('missing', `${p.name} is missing from ${folder}. Re-import the shoot, then run again.`); }
    // the guard: nothing the AI marked sensitive (nudity, ID cards…) goes public unless the owner says so for this album
    if (ctx.album.public && !stored?.allowSensitive) {
      const flagged = ctx.photos.filter(p => seen.get(p.id)?.aiSeen?.sensitive);
      if (flagged.length) throw new Problem('sensitive', `The AI marked ${flagged.length === 1 ? 'a photo' : `${flagged.length} photos`} in this public album as possibly sensitive (nudity or private papers): ${flagged.slice(0, 5).map(p => p.name).join(', ')}${flagged.length > 5 ? '…' : ''}. Reject ${flagged.length === 1 ? 'it' : 'them'} on the Review tab, or publish anyway.`);
    }
    ctx.done = `Signed in as ${ctx.owner} · ${ctx.photos.length} photos to publish`;
  },

  async find(ctx, folder) {
    let catalog = null;
    try {
      const f = await api(ctx.auth, 'GET', `/repos/${ctx.owner}/${CATALOG}/contents/catalog.json`);
      catalog = JSON.parse(Buffer.from(f.content, 'base64').toString());
    } catch (e) { if (e.kind !== 'notfound') throw e; }
    ctx.catalog = catalog || { schema: 1, albums: [] };
    let id = ctx.album.id;
    if (!id) {
      // already put up by hand or from another PC? the same photos give the same ids
      // ...but never an album another shoot here already publishes, and only when most photos match both ways
      const mine = new Set(ctx.photos.map(p => p.h));
      const taken = new Set(db.prepare('SELECT folder, data FROM albums WHERE folder != ?').all(folder).map(r => JSON.parse(r.data).id).filter(Boolean));
      for (const a of ctx.catalog.albums.filter(a => !taken.has(a.id))) {
        ctx.detail(`Looking at “${a.title}” on GitHub`);
        const m = await manifestOf(ctx, a.repos[0], a.encrypted, a.id);
        const same = m ? m.photos.filter(p => mine.has(p.h)).length : 0;
        if (same && same >= m.photos.length * 0.6 && same >= mine.size * 0.6) { id = a.id; ctx.log(`This shoot is already published as “${a.title}”; updating it.`); break; }
      }
    }
    const entry = ctx.catalog.albums.find(a => a.id === id);
    ctx.id = id || newId();
    ctx.media = entry?.repos[0] || `lamha-a-${ctx.id}-media`;
    if (entry && !ctx.publicChosen) {
      // published before and never set here: public if the live site shows it now
      const site = await api(ctx.auth, 'GET', `/repos/${ctx.owner}/${SITE_REPO}/contents/media/lamha-catalog/catalog.json`).catch(e => e.kind === 'notfound' ? null : Promise.reject(e));
      ctx.album.public = entry.public ?? (!!site && JSON.parse(Buffer.from(site.content, "base64").toString()).albums.some(a => a.id === entry.id));
    }
    ctx.encrypted = entry ? !!entry.encrypted : !ctx.album.public; // public albums can't be encrypted; private ones are
    if (ctx.album.public && ctx.encrypted) throw new Problem('encrypted-public', 'This album was published encrypted, so it can’t be shown on the public site.');
    ctx.prev = entry ? await manifestOf(ctx, ctx.media, ctx.encrypted, ctx.id) : null;
    ctx.epoch = epochFor(ctx.id);
    ctx.akey = firebase.albumKey(ctx.keys, ctx.id, ctx.epoch);
    ctx.entry = entry;
    // remember the id at once, so a run that stops halfway carries on with the same repositories
    const row = db.prepare('SELECT data FROM albums WHERE folder = ?').get(folder);
    const stored = row ? JSON.parse(row.data) : null;
    if (stored) { stored.id = ctx.id; stored.public = ctx.album.public; db.prepare('UPDATE albums SET data = ? WHERE folder = ?').run(JSON.stringify(stored), folder); }
    else db.prepare('INSERT INTO albums (folder, data) VALUES (?, ?)').run(folder, JSON.stringify({ id: ctx.id, public: ctx.album.public, unsaved: true }));
    ctx.done = entry ? `Updating “${entry.title}” (${ctx.media})` : `New album ${ctx.id}`;
  },

  async copies(ctx) {
    const done = new Map((ctx.prev?.photos || []).map(p => [p.h, p]));
    await ensureRepo(ctx, ctx.media, 'private');
    ctx.wc = await workingCopy(ctx, ctx.media);
    // an album can span several repositories (lamha-a-<id>-media, -part2, …): each is filled to about 3.5 GB,
    // then new copies go to the next; the manifest always stays in the first
    ctx.repos = [...new Set([ctx.media, ...(ctx.entry?.repos || [])])];
    ctx.wcs = new Map([[ctx.media, ctx.wc]]);
    for (const r of ctx.repos.slice(1)) ctx.wcs.set(r, await workingCopy(ctx, r));
    const sizeOf = async r => ((await api(ctx.auth, 'GET', `/repos/${ctx.owner}/${r}`).catch(() => ({ size: 0 }))).size || 0) * 1024;
    let target = ctx.repos.at(-1), room = ROLL() - await sizeOf(target);
    let turn = Promise.resolve();
    const placeFor = bytes => (turn = turn.then(() => place(bytes))); // two photos are made at once: one decides at a time
    const place = async bytes => { // the repository this file goes to
      if (bytes > room) {
        target = `${ctx.media}-part${ctx.repos.length + 1}`;
        await ensureRepo(ctx, target, 'private');
        ctx.wcs.set(target, await workingCopy(ctx, target));
        ctx.repos.push(target); room = ROLL();
        ctx.log(`${ctx.repos.at(-2)} is full: new copies go to ${target}`);
      }
      room -= bytes;
      return target;
    };
    const hasFile = v => v.site || ctx.wcs.get(v.repo)?.has.has(v.path);
    // new photos, photos whose files are missing, and photos edited (or un-edited) since the last publish
    const whole = p => !done.has(p.h) || !Object.values(done.get(p.h).v || {}).every(hasFile) || (done.get(p.h).e || null) !== p.ehash || (done.get(p.h).q || 1) !== ENC
      || (ctx.encrypted && (done.get(p.h).k || 0) !== ctx.epoch); // locked again: sealed anew with the new key
    const missing = p => Object.keys(VARIANTS).filter(n => !done.get(p.h)?.v?.[n]); // a size added since it went up
    const todo = ctx.photos.filter(p => whole(p) || missing(p).length);
    ctx.newFiles = [];
    let n = 0;
    const work = async p => {
      const original = await fs.promises.readFile(p.path);
      if (sha256(original) !== p.sha256) throw new Problem('changed', `${p.name} changed since it was imported. Re-import the shoot, then run again.`);
      const taken = p.taken ? new Date(p.taken) : new Date((await fs.promises.stat(p.path)).mtime);
      const shard = `${taken.getFullYear()}/${String(taken.getMonth() + 1).padStart(2, '0')}`;
      // with its edits, if it has any; either way every copy is made from the original
      const at = async edge => p.edits ? edited(p.path, p.edits, edge) : sharp(RAW.test(p.path) ? readable(p.path, p.sha256) : original, { failOn: 'none' }).rotate().resize(edge, edge, { fit: 'inside', withoutEnlargement: true });
      const { data, info } = await (await at(32)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      // up already and unchanged: only the sizes it lacks; everything else stays as it is
      const only = whole(p) ? null : new Set(missing(p)), prev = done.get(p.h);
      const v = only ? { ...prev.v } : {};
      let size = null;
      for (const [name, edge] of Object.entries(VARIANTS)) {
        if (only && !only.has(name)) continue;
        const { data: avif, info: out } = await (await at(edge)).avif(AVIF(name)).toBuffer({ resolveWithObject: true }); // metadata is dropped
        if (name === 'full') size = out;
        const bytes = ctx.encrypted ? seal(ctx.akey, avif) : avif;
        if (bytes.length > MAX_FILE) throw new Problem('toobig', `${p.name} makes a ${name} copy over 25 MB.`);
        const rel = `${name}/${shard}/${p.h}.${ctx.encrypted ? 'bin' : 'avif'}`;
        const repo = await placeFor(bytes.length), dir = ctx.wcs.get(repo).dir;
        await fs.promises.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await fs.promises.writeFile(path.join(dir, rel), bytes);
        ctx.newFiles.push({ repo, rel, size: bytes.length });
        v[name] = { repo, path: rel, blob: blobSha(bytes), type: 'image/avif', bytes: avif.length };
      }
      p.made = only ? { blurhash: prev.blurhash, v, q: prev.q, ...(prev.e && { w: prev.w, hgt: prev.hgt }) }
        : { blurhash: blurhash(new Uint8ClampedArray(data), info.width, info.height, 4, 3), v, q: ENC, ...(ctx.encrypted && ctx.epoch && { k: ctx.epoch }), ...(p.edits && { w: size.width, hgt: size.height }) };
      ctx.detail(`${++n} of ${todo.length}: ${p.name}`);
    };
    for (let i = 0; i < todo.length; i += 2) await Promise.all(todo.slice(i, i + 2).map(work)); // two at a time
    ctx.done = todo.length ? `${todo.length} new photo${todo.length === 1 ? '' : 's'} · ${ctx.photos.length - todo.length} already on GitHub` : `All ${ctx.photos.length} photos are already on GitHub`;
  },

  // full-size copies of new or changed photos, into the lamha-full-N repositories (see FULL_REPO_LIMIT)
  async full(ctx) {
    ctx.orig = new Map(); // photo id (h) -> its full-size entry for the manifest
    if (ctx.album.full === false) { ctx.done = 'Off for this album (Publish tab)'; return 'skipped'; }
    const prev = new Map((ctx.prev?.photos || []).map(p => [p.h, p]));
    const todo = ctx.photos.filter(p => { const o = prev.get(p.h)?.v?.orig; return !o || (o.e || null) !== (p.ehash || null) || o.q !== FULLQ || !!o.sealed !== !!ctx.encrypted || (ctx.encrypted && (o.k || 0) !== ctx.epoch); });
    if (!todo.length) { ctx.done = `All ${ctx.photos.length} are already there`; return; }
    const repos = JSON.parse(setting('fullRepos', '[]')); // [{ name, bytes }], filled in order
    let cur = null, wc = null, pending = [], pendingBytes = 0, sent = 0, made = 0;
    const flush = async () => {
      if (!pending.length) return;
      for (let j = 0; j < pending.length; j += 200) await git(wc.dir, ['add', '--', ...pending.slice(j, j + 200)], ctx.env);
      if (await commit(ctx, wc.dir, `full-size, ${pending.length} photos`)) await push(ctx, wc.dir, `full-size photos to ${cur.name} (${Math.round(sent / 1e6)} MB so far)`);
      setSetting('fullRepos', JSON.stringify(repos));
      pending = []; pendingBytes = 0;
    };
    const open = async () => {
      if (cur && cur.bytes < FULL_REPO_LIMIT) return;
      await flush();
      cur = repos.find(r => r.bytes < FULL_REPO_LIMIT);
      if (!cur) { cur = { name: `lamha-full-${repos.length + 1}`, bytes: 0 }; repos.push(cur); }
      await ensureRepo(ctx, cur.name, 'public');
      wc = await workingCopy(ctx, cur.name);
      if (!wc.has.has('.nojekyll')) { fs.writeFileSync(path.join(wc.dir, '.nojekyll'), ''); pending.push('.nojekyll'); }
    };
    for (const p of todo) {
      await open();
      const pipe = p.edits ? await edited(p.path, p.edits, 100000) : sharp(readable(p.path, p.sha256), { failOn: 'none', limitInputPixels: false }).rotate();
      const jpg = await pipe.keepIccProfile().jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer(); // metadata (and GPS) dropped
      const bytes = ctx.encrypted ? seal(ctx.akey, jpg) : jpg;
      if (bytes.length > FULL_MAX_FILE) { ctx.log(`${p.name}: its full-size copy is over 95 MB, too big for GitHub; the large view uses the 3000 px copy`); continue; }
      const rel = `${ctx.id}/${p.h}.${ctx.encrypted ? 'bin' : 'jpg'}`;
      fs.mkdirSync(path.join(wc.dir, ctx.id), { recursive: true });
      fs.writeFileSync(path.join(wc.dir, rel), bytes);
      pending.push(rel); pendingBytes += bytes.length; sent += bytes.length; cur.bytes += bytes.length;
      ctx.orig.set(p.h, { site: cur.name, path: rel, type: 'image/jpeg', bytes: jpg.length, q: FULLQ, ...(p.ehash && { e: p.ehash }), ...(ctx.encrypted && { sealed: true }), ...(ctx.encrypted && ctx.epoch && { k: ctx.epoch }) });
      ctx.detail(`${++made} of ${todo.length}: ${p.name} · ${Math.round(sent / 1e6)} MB`);
      if (pendingBytes >= BATCH) await flush();
    }
    await flush();
    // each one is its own little Pages site (public repositories get it free)
    for (const r of repos) {
      try { await api(ctx.auth, 'GET', `/repos/${ctx.owner}/${r.name}/pages`); }
      catch (e) { if (e.kind !== 'notfound') throw e; await api(ctx.auth, 'POST', `/repos/${ctx.owner}/${r.name}/pages`, { source: { branch: 'main', path: '/' } }); ctx.log(`Turned on GitHub Pages for ${r.name}`); }
    }
    ctx.done = `${made} full-size photo${made === 1 ? '' : 's'} · ${Math.round(sent / 1e6)} MB uploaded`;
  },

  async photos(ctx) {
    const { dir } = ctx.wc;
    const all = ctx.newFiles;
    let batch = 0, total = all.reduce((s, f) => s + f.size, 0), sent = 0;
    for (const repo of ctx.repos) { // each repository's new files, in batches
      const files = all.filter(f => f.repo === repo), rdir = ctx.wcs.get(repo).dir;
      let i = 0;
      while (i < files.length) {
        const list = [];
        for (let size = 0; i < files.length && (!list.length || size + files[i].size <= BATCH); i++) { list.push(files[i].rel); size += files[i].size; sent += files[i].size; }
        for (let j = 0; j < list.length; j += 200) await git(rdir, ['add', '--', ...list.slice(j, j + 200)], ctx.env);
        if (await commit(ctx, rdir, `photos, batch ${++batch} (${list.length} files)`)) await push(ctx, rdir, `batch ${batch}: ${Math.round(sent / 1e6)} of ${Math.round(total / 1e6)} MB${repo === ctx.media ? '' : ` (${repo})`}`);
      }
    }
    const files = all;
    // the manifest: every photo in the album, last
    const prev = new Map((ctx.prev?.photos || []).map(p => [p.h, p]));
    let next = Math.max(-1, ...[...prev.values()].map(p => p.n ?? -1)) + 1;
    const keepOld = ctx.prev && !ctx.albumSaved; // arranged by hand before: keep its titles and chapters
    const names = (ids, kind) => ids.map(id => ctx.tagInfo.get(id)).filter(t => t?.kind === kind).map(t => t.name);
    const photos = ctx.photos.map(p => {
      const old = prev.get(p.h);
      // a photo already published keeps its entry as it is; new or re-made ones are described here
      const m = p.made || !old ? {
        ...(old || {}), h: p.h, n: old?.n ?? next++, src: old?.src ?? p.name.replace(/\.[^.]+$/, ''), title: old?.title ?? null, tags: old?.tags ?? [],
        taken: p.taken, w: p.w, hgt: p.hgtPx, camera: p.camera, lens: p.lens, iso: p.iso, shutter: p.shutter, f: p.f, geo: null, ...p.made,
      } : { ...old };
      if (p.ehash) m.e = p.ehash; else delete m.e;
      // its full-size copy: just made, or the one it had (a re-made photo keeps it unless it changed)
      const orig = ctx.orig?.get(p.h) || (ctx.album.full !== false && old?.v?.orig && (old.v.orig.e || null) === (p.ehash || null) && (old.v.orig.k || 0) === (ctx.encrypted ? ctx.epoch : 0) ? old.v.orig : null);
      m.v = { ...m.v }; if (orig) m.v.orig = orig; else delete m.v.orig;
      // words: an album arranged here says exactly what it shows; one arranged before only gains what was added here
      const tags = names(p.tags, 'tag'), people = names(p.tags, 'person');
      if (!keepOld) { m.title = p.title || null; m.tags = tags; }
      else { if (p.title) m.title = p.title; if (tags.length) m.tags = tags; }
      if (p.description) m.desc = p.description; else if (!keepOld) delete m.desc;
      if (people.length) m.people = people; else if (!keepOld) delete m.people;
      // what the AI saw, so the site's search finds photos by what is in them ("kids at the beach")
      if (p.aiDescription || p.aiTags?.length) m.ai = { d: p.aiDescription || '', t: p.aiTags || [] }; else delete m.ai;
      if (ctx.emb?.get(p.id)) m.emb = ctx.emb.get(p.id); else delete m.emb; // search by meaning (site/meaning.js)
      // where it was taken: only if chosen for this album, and rounded to two decimals (about 1 km)
      m.geo = ctx.album.geo && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? [Math.round(p.lat * 100) / 100, Math.round(p.lon * 100) / 100] : null;
      return m;
    });
    const was = new Map((ctx.prev?.photos || []).map((p, i) => [p.h, i])); // photos taken in the same second keep their old order
    photos.sort((a, b) => (a.taken || '').localeCompare(b.taken || '') || (was.get(a.h) ?? 1e9) - (was.get(b.h) ?? 1e9));
    const byH = new Map(photos.map(m => [m.h, m]));
    const src = new Map(ctx.photos.map(p => [p.id, byH.get(p.h).src]));
    let chapters = keepOld ? ctx.prev.chapters : ctx.album.chapters;
    if (!keepOld) {
      // arranged here: the chapters and the order exactly as on the Album page; each photo says its chapter
      const parts = assign(ctx.album, ctx.photos, ctx.tagInfo);
      chapters = parts.map(c => ({ title: c.title, sub: c.sub }));
      let n = 0;
      parts.forEach((c, ci) => c.photos.forEach(p => Object.assign(byH.get(p.h), { n: n++, c: ci })));
    }
    ctx.manifest = {
      schema: 1, album: ctx.id, title: keepOld ? ctx.prev.title : ctx.album.title, encrypted: ctx.encrypted, embedModel: null,
      ...(keepOld ? (ctx.prev.description && { description: ctx.prev.description }) : (ctx.album.description && { description: ctx.album.description })),
      chapters,
      highlights: keepOld ? ctx.prev.highlights : ctx.album.highlights.map(id => src.get(id)).filter(Boolean),
      photos,
    };
    ctx.coverSrc = keepOld ? null : src.get(ctx.album.cover);
    const json = Buffer.from(JSON.stringify(ctx.manifest, null, ctx.encrypted ? 0 : 1));
    const same = ctx.prev && JSON.stringify(ctx.prev) === JSON.stringify(ctx.manifest);
    if (!same) {
      fs.writeFileSync(path.join(dir, 'manifest.json'), ctx.encrypted ? seal(ctx.akey, json) : json);
      await git(dir, ['add', '--', 'manifest.json'], ctx.env);
      if (await commit(ctx, dir, 'manifest')) await push(ctx, dir, 'the album list');
    }
    ctx.manifestBlob = (await git(dir, ['rev-parse', 'HEAD:manifest.json'], ctx.env)).trim();
    ctx.done = `${files.length ? `${files.length} files uploaded` : 'No new files'}${same ? ' · album list unchanged' : ' · album list updated'}`;
  },

  async shell(ctx) {
    const name = `lamha-a-${ctx.id}`;
    await ensureRepo(ctx, name, 'public');
    const wc = await workingCopy(ctx, name);
    const body = JSON.stringify({ schema: 1, id: ctx.id, theme: 'default' }, null, 1) + '\n';
    fs.writeFileSync(path.join(wc.dir, 'album.json'), body);
    await git(wc.dir, ['add', '--', 'album.json'], ctx.env);
    const changed = await commit(ctx, wc.dir, 'album shell');
    if (changed) await push(ctx, wc.dir, 'the placeholder');
    ctx.done = changed ? name : `${name} (already there)`;
  },

  async catalog(ctx) {
    await ensureRepo(ctx, CATALOG, 'private');
    const wc = await workingCopy(ctx, CATALOG); // fresh from GitHub each time, so nothing from another PC is lost
    const catalog = wc.has.has('catalog.json') ? JSON.parse((await read(ctx, wc.dir, 'catalog.json')).toString()) : { schema: 1, albums: [] };
    const photos = ctx.manifest.photos;
    const cover = photos.find(p => p.src === ctx.coverSrc) || (ctx.entry?.cover && photos.find(p => p.v.md.blob === ctx.entry.cover.blob)) || photos.find(p => ctx.manifest.highlights.includes(p.src)) || photos[0];
    const dates = photos.map(p => p.taken).filter(Boolean).sort();
    const entry = {
      ...(ctx.entry || {}),
      id: ctx.id, title: ctx.manifest.title,
      dateStart: dates[0]?.slice(0, 10) ?? null, dateEnd: dates.at(-1)?.slice(0, 10) ?? null,
      count: photos.length,
      cover: { repo: cover.v.md.repo, path: cover.v.md.path, blob: cover.v.md.blob, w: cover.w, hgt: cover.hgt, blurhash: cover.blurhash },
      repos: ctx.repos || ctx.entry?.repos || [ctx.media], groups: ctx.album.groups ? ['owner', ...ctx.album.groups] : ctx.entry?.groups || ['owner'],
      encrypted: ctx.encrypted, manifestBlob: ctx.manifestBlob, public: ctx.album.public,
    };
    const old = catalog.albums.find(a => a.id === ctx.id);
    const same = JSON.stringify(old) === JSON.stringify(entry);
    if (!same) {
      catalog.albums = [...catalog.albums.filter(a => a.id !== ctx.id), entry];
      catalog.updatedAt = new Date().toISOString();
      fs.writeFileSync(path.join(wc.dir, 'catalog.json'), JSON.stringify(catalog, null, 1) + '\n');
      await git(wc.dir, ['add', '--', 'catalog.json'], ctx.env);
      if (await commit(ctx, wc.dir, `album ${ctx.id}`)) await push(ctx, wc.dir, 'the catalog');
    }
    ctx.catalog = catalog;
    ctx.done = same ? 'Already listed, nothing changed' : old ? 'Listing updated' : 'Listed';
  },

  async site(ctx) {
    const pub = ctx.catalog.albums.filter(a => a.public && !a.encrypted);
    // private albums go on the site still sealed, for the people Firebase lets have their key
    const sealed = firebase.isOn() ? ctx.catalog.albums.filter(a => a.encrypted && !a.public) : [];
    if (!ctx.siteOnly && !ctx.album.public && !ctx.entry?.public && !firebase.isOn()) { ctx.done = 'This album is private and sharing isn’t set up, so the site is left alone'; return 'skipped'; }
    await ensureRepo(ctx, SITE_REPO, 'public');
    const wc = await workingCopy(ctx, SITE_REPO);
    // the site's own files, stamped so browsers never mix an old file with a new one
    const files = fs.readdirSync(SITE, { recursive: true }).filter(f => fs.statSync(path.join(SITE, f)).isFile()).map(f => f.split(path.sep).join('/'));
    const stamp = sha256(Buffer.concat(files.map(f => fs.readFileSync(path.join(SITE, f))))).slice(0, 10);
    const want = new Map();
    for (const f of files) {
      let buf = fs.readFileSync(path.join(SITE, f));
      if (/\.(js|html)$/.test(f)) buf = Buffer.from(buf.toString()
        .replace(/(from\s+|import\s+|import\()(['"])(\.\.?\/[^'"]+\.js)\2/g, `$1$2$3?v=${stamp}$2`)
        .replace(/(src|href)="((?!https?:|\/\/)[^"]+\.(?:js|css|svg))"/g, `$1="$2?v=${stamp}"`));
      want.set(f, buf);
    }
    want.set('.nojekyll', Buffer.alloc(0));
    // where the access check is and which Google sign-in to use (set up on the People screen); {} = public albums only
    want.set('config.json', Buffer.from(`${setting('siteConfig', '') || '{}'}\n`));
    want.set('media/lamha-catalog/catalog.json', Buffer.from(JSON.stringify({ schema: 1, updatedAt: ctx.catalog.updatedAt, albums: pub.map(({ groups, ...a }) => a) }, null, 1) + '\n'));
    // each public album's copies and list, taken from its own repository (only what the site lacks)
    const keepMedia = new Set();
    for (const a of [...pub, ...sealed]) {
      const isThis = !ctx.siteOnly && a.id === ctx.id;
      const src = isThis ? ctx.wc : await workingCopy(ctx, a.repos[0]);
      const raw = isThis ? null : await read(ctx, src.dir, 'manifest.json');
      const m = isThis ? ctx.manifest : JSON.parse((a.encrypted ? unseal(ctx.keys, a.id, raw) : raw).toString());
      const manifestAt = `media/${a.repos[0]}/manifest.json`;
      keepMedia.add(manifestAt);
      want.set(manifestAt, isThis ? (a.encrypted ? fs.readFileSync(path.join(src.dir, 'manifest.json')) : Buffer.from(JSON.stringify(m, null, 1))) : raw);
      // every copy, from the repository it lives in (an album can span -part2, -part3…); full-size ones live in lamha-full-N
      const repoWc = new Map(isThis ? ctx.wcs : [[a.repos[0], src]]);
      let n = 0;
      for (const v of m.photos.flatMap(p => Object.values(p.v).filter(v => !v.site))) {
        const to = `media/${v.repo}/${v.path}`;
        keepMedia.add(to);
        if (wc.has.has(to) && (!v.blob || wc.blob.get(to) === v.blob)) continue; // there and the same (sealed anew or re-made: copied again)
        if (!repoWc.has(v.repo)) repoWc.set(v.repo, await workingCopy(ctx, v.repo));
        const from = repoWc.get(v.repo), local = path.join(from.dir, v.path);
        want.set(to, fs.existsSync(local) ? fs.readFileSync(local) : await read(ctx, from.dir, v.path));
        if (++n % 20 === 0) ctx.detail(`Copying ${a.title}: ${n} files`);
      }
    }
    // write what changed, drop what the site no longer has
    const changed = [];
    for (const [rel, buf] of want) { // git only records the ones whose content really differs
      const file = path.join(wc.dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      changed.push(rel);
    }
    for (let j = 0; j < changed.length; j += 200) await git(wc.dir, ['add', '--', ...changed.slice(j, j + 200)], ctx.env);
    const gone = [...wc.has].filter(f => !want.has(f) && !keepMedia.has(f));
    for (let j = 0; j < gone.length; j += 200) await git(wc.dir, ['rm', '-q', '--cached', '--', ...gone.slice(j, j + 200)], ctx.env);
    const pushed = await commit(ctx, wc.dir, `site: ${pub.map(a => a.title).join(', ') || 'no public albums'}${sealed.length ? ` + ${sealed.length} private (sealed)` : ''}`);
    if (pushed) await push(ctx, wc.dir, 'the site');
    // GitHub Pages on (free for public repositories), then wait until the new version is live
    let pages;
    try { pages = await api(ctx.auth, 'GET', `/repos/${ctx.owner}/${SITE_REPO}/pages`); }
    catch (e) {
      if (e.kind !== 'notfound') throw e;
      pages = await api(ctx.auth, 'POST', `/repos/${ctx.owner}/${SITE_REPO}/pages`, { source: { branch: 'main', path: '/' } });
      ctx.log('Turned on GitHub Pages for the site');
    }
    const head = (await git(wc.dir, ['rev-parse', 'HEAD'], ctx.env)).trim();
    ctx.url = pages.html_url || `https://${ctx.owner.toLowerCase()}.github.io/${SITE_REPO}/`;
    for (let t = 0; ; t += 10) {
      if (t > 600) throw new Problem('pages-slow', 'GitHub Pages hasn’t finished putting the site up after 10 minutes. It usually catches up on its own; run again later to check.', { url: `${urls(ctx.auth.host).web}/${ctx.owner}/${SITE_REPO}/actions` });
      const b = await api(ctx.auth, 'GET', `/repos/${ctx.owner}/${SITE_REPO}/pages/builds/latest`).catch(e => e.kind === 'notfound' ? null : Promise.reject(e));
      if (b?.status === 'errored') throw new Problem('pages', `GitHub Pages couldn’t build the site: ${b.error?.message || 'no reason given'}.`, { url: `${urls(ctx.auth.host).web}/${ctx.owner}/${SITE_REPO}/actions` });
      if (b?.status === 'built' && b.commit === head) {
        const live = await fetch(`${ctx.url.replace(/\/?$/, '/')}media/lamha-catalog/catalog.json?check=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(20e3) }).then(r => r.ok ? r.json() : null).catch(() => null);
        if (ctx.siteOnly || live?.albums?.some(a => a.id === ctx.id) || !ctx.album.public) break;
      }
      ctx.detail(`Waiting for GitHub Pages to put the site up (${t} s)`);
      await sleep(10e3);
    }
    ctx.summary = `${pub.length} public album${pub.length === 1 ? '' : 's'} on the site`;
    ctx.done = `${pushed ? 'Site updated' : 'Site already up to date'} · live at ${ctx.url}`;
  },
};

// the site alone (its files, its settings, the public albums), e.g. after private viewing is set up
// An album published before it was arranged here (its titles, tags and chapters were made by hand on
// GitHub): bring all of that into the library, so the album here says what the site says, and publishing
// from here keeps it. Photos are matched by their id (the HMAC of the original), never by name.
export async function adoptFromGitHub(folder) {
  const auth = await fresh();
  if (!auth) throw new Problem('signin', 'Sign in to GitHub first (Publish tab).');
  const row = db.prepare('SELECT data FROM albums WHERE folder = ?').get(folder);
  const stored = row ? JSON.parse(row.data) : null;
  if (!stored?.id) throw new Problem('notpublished', 'This album isn’t on GitHub yet, so there is nothing to bring in.');
  const ctx = { auth, owner: (await check(auth)).login, keys: loadKeys() };
  // sealed if private; an album that changed sides since is read the other way
  const repo = `lamha-a-${stored.id}-media`;
  const m = await manifestOf(ctx, repo, !stored.public, stored.id).catch(() => manifestOf(ctx, repo, !!stored.public, stored.id));
  if (!m) throw new Problem('manifest', 'The album’s list of photos isn’t on GitHub.');
  const local = new Map(db.prepare('SELECT id, sha256 FROM photos WHERE folder = ?').all(folder).map(p => [photoId(ctx.keys, p.sha256), p.id]));
  let matched = 0;
  const bySrc = new Map();
  for (const p of m.photos) {
    const id = local.get(p.h);
    if (!id) continue;
    matched++; bySrc.set(p.src, id);
    if (p.title || p.desc) setText(id, { title: p.title || '', description: p.desc || '' });
    for (const t of p.tags || []) tagPhotos([id], { name: t, kind: 'tag' });
    for (const n of p.people || []) tagPhotos([id], { name: n, kind: 'person' });
  }
  const rules = (m.chapters || []).filter(c => c.tags?.length).map(c => ({ title: c.title || '', sub: c.sub || '', tags: c.tags }));
  const rest = (m.chapters || []).find(c => !c.tags?.length); // the one that takes the rest
  const album = { ...stored, title: m.title || stored.title, ...(m.description && { description: m.description }),
    highlights: (m.highlights || []).map(s => bySrc.get(s)).filter(Boolean), ...(rules.length && { rules, groupBy: 'rules' }), ...(rest && { rest: { title: rest.title || '', sub: rest.sub || '' } }) };
  delete album.unsaved;
  db.prepare('UPDATE albums SET data = ? WHERE folder = ?').run(JSON.stringify(album), folder);
  return { matched, photos: m.photos.length, chapters: rules.length };
}

// Removing deleted photos for good. Normally a photo taken out of an album only leaves its list, and git
// keeps its files in the history. This takes the files no longer listed out of every repository the album
// uses (its own, the full-size ones, the site) and starts each one's history again from what is there now,
// so the old files are no longer part of it. GitHub clears them from its storage some time after.
export async function purgeAlbum(folder, detail = () => {}) {
  if (active) throw new Problem('busy', 'Wait for publishing to finish.');
  const auth = await fresh();
  if (!auth) throw new Problem('signin', 'Sign in to GitHub first.');
  const row = db.prepare('SELECT data FROM albums WHERE folder = ?').get(folder);
  const stored = row ? JSON.parse(row.data) : null;
  if (!stored?.id) throw new Problem('notpublished', 'This album isn’t on GitHub.');
  active = { folder, cancel: false };
  try {
    const ctx = { auth, owner: (await check(auth)).login, keys: loadKeys(), env: gitEnv(auth), lastPush: 0, log: () => {}, detail };
    const base = `lamha-a-${stored.id}-media`;
    const m = await manifestOf(ctx, base, !stored.public, stored.id).catch(() => manifestOf(ctx, base, !!stored.public, stored.id));
    if (!m) throw new Problem('manifest', 'The album’s list isn’t on GitHub.');
    const keep = new Map(); // repository -> the files this album still uses there
    const add = (repo, file) => { if (!keep.has(repo)) keep.set(repo, new Set()); keep.get(repo).add(file); };
    add(base, 'manifest.json');
    for (const p of m.photos) for (const v of Object.values(p.v)) v.site ? add(v.site, v.path) : add(v.repo, v.path);
    const owned = (repo, file) => repo.startsWith('lamha-full-') ? file.startsWith(`${stored.id}/`) : true; // a full-size repository holds other albums too
    let removed = 0;
    const squash = async (repo, drop) => {
      const wc = await workingCopy(ctx, repo);
      const gone = [...wc.has].filter(drop);
      for (let j = 0; j < gone.length; j += 200) await git(wc.dir, ['rm', '-q', '--cached', '--', ...gone.slice(j, j + 200)], ctx.env);
      if (gone.length) await commit(ctx, wc.dir, `remove ${gone.length} deleted files`);
      removed += gone.length;
      // the same files, with a history of one: everything older is let go
      const tree = (await git(wc.dir, ['rev-parse', 'HEAD^{tree}'], ctx.env)).trim();
      const fresh1 = (await git(wc.dir, ['commit-tree', tree, '-m', 'Lamhaat: history cleared of deleted photos'], ctx.env)).trim();
      detail(`Clearing the history of ${repo}`);
      await git(wc.dir, ['push', '-q', '--force', 'origin', `${fresh1}:refs/heads/main`], ctx.env);
      await git(wc.dir, ['reset', '-q', fresh1], ctx.env);
    };
    for (const [repo, files] of keep) await squash(repo, f => owned(repo, f) && !files.has(f) && f !== '.nojekyll');
    // the site (public albums, and private ones sealed): this album's files it no longer needs
    if (await api(ctx.auth, 'GET', `/repos/${ctx.owner}/${SITE_REPO}`).then(() => true, () => false)) {
      const mine = new Set([...keep].filter(([r]) => !r.startsWith('lamha-full-')).flatMap(([r, files]) => [...files].map(f => `media/${r}/${f}`)));
      const prefixes = [...keep.keys()].filter(r => !r.startsWith('lamha-full-')).map(r => `media/${r}/`);
      await squash(SITE_REPO, f => prefixes.some(pre => f.startsWith(pre)) && !mine.has(f));
    }
    return { removed };
  } finally { active = null; }
}

export async function publishSite(detail = () => {}) {
  if (active) throw new Problem('busy', 'An album is publishing. Wait for it to finish.');
  active = { folder: '(site)', cancel: false };
  try {
    const auth = await fresh();
    if (!auth) throw new Problem('signin', 'Sign in to GitHub first.');
    const ctx = { siteOnly: true, auth, env: gitEnv(auth), lastPush: 0, log: () => {}, detail: t => detail(t) };
    ctx.owner = (await check(auth)).login;
    const f = await api(auth, 'GET', `/repos/${ctx.owner}/${CATALOG}/contents/catalog.json`).catch(e => e.kind === 'notfound' ? null : Promise.reject(e));
    ctx.catalog = f ? JSON.parse(Buffer.from(f.content, 'base64').toString()) : { schema: 1, albums: [] };
    await STEP.site(ctx);
    return ctx.done;
  } finally { active = null; }
}
