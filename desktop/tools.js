// The programs Lamhaat leans on, found, started and (with the owner's OK) installed by the app itself, so
// nobody has to know what Git or Ollama is. Each one is looked for where it may already be (on the PATH,
// where its own installer puts it, or in the library's tools folder); only what is missing is offered, with
// its size, and nothing downloads until the owner clicks.
//   git       publishing (MinGit, the small portable Git, into tools\git)
//   ollama    the local AI server; started when the app starts, and again whenever it is found stopped
//   model     the vision model the AI uses, pulled through Ollama
//   upscaler  Real-ESRGAN, for bigger and sharper photos (upscale.js)
//   raw       LibRaw's developer, for RAW photos (tools\libraw)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { dataDir, setting } from './db.js';
import { Problem } from './github.js';
import * as upscale from './upscale.js';
import * as raw from './raw.js';

const TOOLS = path.join(dataDir, 'tools');
const OLLAMA = () => setting('ollama', 'http://127.0.0.1:11434');
const MODEL = () => setting('visionModel', 'qwen2.5vl:7b');
const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const where = name => (process.env.PATH || '').split(path.delimiter).map(d => path.join(d, name)).find(f => fs.existsSync(f));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// where downloads come from (tests point these at a server on this PC)
const URLS = {
  git: process.env.LAMHAAT_URL_GIT || null, // the newest MinGit, asked of GitHub when null
  ollama: process.env.LAMHAAT_URL_OLLAMA || 'https://ollama.com/download/OllamaSetup.exe',
  raw: process.env.LAMHAAT_URL_LIBRAW || 'https://www.libraw.org/data/LibRaw-0.21.3-Win64.zip',
};

// ---------- finding them ----------
export const gitPath = () => [path.join(TOOLS, 'git', 'cmd', 'git.exe')].find(f => fs.existsSync(f)) || where('git.exe') || 'git';
export const hasGit = () => gitPath() !== 'git' || !!where('git');
export const ollamaPath = () => [process.env.LAMHAAT_OLLAMA, path.join(local, 'Programs', 'Ollama', 'ollama.exe')].find(f => f && fs.existsSync(f)) || where('ollama.exe');
const api = (p, opts = {}) => fetch(`${OLLAMA()}${p}`, { signal: AbortSignal.timeout(4000), ...opts }).then(r => r.json());
export const ollamaRunning = () => api('/api/version').then(r => !!r.version, () => false);
const hasModel = () => api('/api/tags').then(t => (t.models || []).some(m => m.name === MODEL() || m.model === MODEL()), () => null);

const busy = {}; // id -> { done, total } while installing
export async function status() {
  const running = await ollamaRunning();
  const model = running ? await hasModel() : null;
  const up = upscale.status();
  return [
    { id: 'git', name: 'Git', why: 'Puts your albums on GitHub when you publish.', ok: hasGit(), size: '50 MB', needed: true },
    { id: 'ollama', name: 'Ollama (the AI server)', why: 'Runs the AI that describes photos and finds people, on this PC.', ok: !!ollamaPath() || running, running, size: '1 GB', needed: true },
    { id: 'model', name: `Vision model (${MODEL()})`, why: 'What the AI looks at photos with.', ok: !!model, unknown: model === null, size: '6 GB', needed: true },
    { id: 'upscaler', name: 'AI upscaler (Real-ESRGAN)', why: 'Bigger and sharper photos. Without it, a careful resize.', ok: up.ai, size: up.size },
    { id: 'raw', name: 'RAW reader (LibRaw)', why: 'Brings in RAW photos (.RAF, .DNG, .NEF, .CR3 and others).', ok: raw.status().raw, size: '3 MB' },
  ].map(t => ({ ...t, installing: busy[t.id] || null }));
}

// ---------- the AI server ----------
let starting = null;
// start Ollama if it is installed and not running; true once it answers
export function startOllama() {
  return starting ||= (async () => {
    if (await ollamaRunning()) return true;
    const exe = ollamaPath();
    if (!exe) return false;
    spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 40; i++) { await sleep(500); if (await ollamaRunning()) return true; }
    return false;
  })().finally(() => { starting = null; });
}
// stop and start it again (when it hangs)
export async function restartOllama() {
  if (process.platform === 'win32') await new Promise(r => execFile('taskkill', ['/IM', 'ollama.exe', '/F'], { windowsHide: true }, () => r()));
  for (let i = 0; i < 10 && await ollamaRunning(); i++) await sleep(300);
  return startOllama();
}

// ---------- installing ----------
async function download(url, file, id, total) {
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) throw new Problem('offline', 'Couldn’t download it. Check the internet connection.');
  busy[id] = { done: 0, total: Number(res.headers.get('content-length')) || total };
  const out = fs.createWriteStream(file);
  for await (const chunk of res.body) { if (!out.write(chunk)) await new Promise(r => out.once('drain', r)); busy[id].done += chunk.length; }
  await new Promise(r => out.end(r));
}
const unzip = (zip, to) => new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${to}' -Force`], { windowsHide: true }, e => e ? reject(e) : resolve()));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-tool-'));

const installers = {
  async git() {
    let url = URLS.git;
    if (!url) {
      const rel = await fetch('https://api.github.com/repos/git-for-windows/git/releases/latest', { headers: { 'user-agent': 'Lamhaat' } }).then(r => r.json()).catch(() => null);
      url = rel?.assets?.find(a => /^MinGit-[\d.]+-64-bit\.zip$/.test(a.name))?.browser_download_url;
      if (!url) throw new Problem('offline', 'Couldn’t find Git to download. Check the internet connection.');
    }
    const tmp = temp();
    try {
      await download(url, path.join(tmp, 'git.zip'), 'git', 50e6);
      fs.rmSync(path.join(TOOLS, 'git'), { recursive: true, force: true });
      await unzip(path.join(tmp, 'git.zip'), path.join(TOOLS, 'git'));
      if (!fs.existsSync(path.join(TOOLS, 'git', 'cmd', 'git.exe'))) throw new Problem('broken', 'The download didn’t have Git in it.');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  },
  async ollama() {
    const tmp = temp();
    try {
      const exe = path.join(tmp, 'OllamaSetup.exe');
      await download(URLS.ollama, exe, 'ollama', 1.1e9);
      busy.ollama = { ...busy.ollama, step: 'Installing' };
      await new Promise((resolve, reject) => execFile(exe, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], { windowsHide: true, timeout: 15 * 60e3 }, e => e ? reject(new Problem('broken', 'Ollama’s installer stopped before finishing.')) : resolve()));
      if (!ollamaPath()) throw new Problem('broken', 'Ollama’s installer finished, but Ollama isn’t where it should be.');
      await startOllama();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  },
  async model() {
    if (!await startOllama()) throw new Problem('noollama', 'The AI server (Ollama) isn’t installed or won’t start.');
    const res = await fetch(`${OLLAMA()}/api/pull`, { method: 'POST', body: JSON.stringify({ model: MODEL(), stream: true }) }).catch(() => null);
    if (!res?.ok) throw new Problem('offline', 'Ollama couldn’t start the download.');
    busy.model = { done: 0, total: 6e9 };
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString();
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        let m; try { m = JSON.parse(buf.slice(0, i)); } catch { continue; }
        if (m.error) throw new Problem('ollama', `Ollama said: ${m.error}`);
        if (m.total) busy.model = { done: m.completed || 0, total: m.total, step: m.status };
      }
    }
    if (!await hasModel()) throw new Problem('broken', 'The download finished, but the model isn’t in Ollama.');
  },
  async upscaler() { await upscale.install(p => { busy.upscaler = p; }); },
  async raw() {
    const tmp = temp();
    try {
      await download(URLS.raw, path.join(tmp, 'libraw.zip'), 'raw', 3.2e6);
      await unzip(path.join(tmp, 'libraw.zip'), path.join(tmp, 'x'));
      const found = fs.readdirSync(path.join(tmp, 'x'), { recursive: true }).find(f => /(^|[\\/])dcraw_emu\.exe$/i.test(f));
      if (!found) throw new Problem('broken', 'The download didn’t have the RAW reader in it.');
      const dir = path.dirname(path.join(tmp, 'x', found)), to = path.join(TOOLS, 'libraw');
      fs.rmSync(to, { recursive: true, force: true }); fs.mkdirSync(to, { recursive: true });
      for (const f of ['dcraw_emu.exe', 'libraw.dll']) fs.copyFileSync(path.join(dir, f), path.join(to, f));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  },
};

// install one; onProgress gets { done, total, step } now and then
export async function install(id, onProgress = () => {}) {
  if (!installers[id]) throw new Problem('tool', 'Unknown tool.');
  if (busy[id]) throw new Problem('busy', 'Already downloading.');
  busy[id] = { done: 0, total: 0 };
  const tick = setInterval(() => busy[id] && onProgress({ id, ...busy[id] }), 250);
  try { await installers[id](); }
  finally { clearInterval(tick); delete busy[id]; }
}
