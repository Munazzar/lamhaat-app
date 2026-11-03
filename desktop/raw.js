// RAW photos (Fuji .RAF and the others LibRaw reads) and AI noise removal, through develop.py.
// A RAW file is developed once, on import, into a full-size JPEG kept in the library (developed\<sha>.jpg);
// everything that shows, checks or publishes the photo reads that picture. The RAW file itself is never
// changed. "Remove noise" redevelops it with the AI (SCUNet, on the graphics card), in place: the photo
// just gets cleaner. For a JPEG, the cleaner picture is a new photo in the shoot's "Enhanced" folder.
// Needs a Python with PyTorch (ComfyUI's, on this PC) and two downloads in the library's tools folder:
// rawpy (tools\py) and the SCUNet model (tools\models).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import exifr from 'exifr';
import sharp from 'sharp';
import { db, dataDir, setting } from './db.js';
import { Problem } from './github.js';

export const RAW = /\.(raf|dng|cr2|cr3|nef|arw|orf|rw2|pef|srw)$/i;
const TOOLS = path.join(dataDir, 'tools');
const DEV = path.join(dataDir, 'developed');
const python = () => process.env.LAMHAAT_PYTHON || setting('python', path.join(os.homedir(), 'ComfyUI', 'venv', 'Scripts', 'python.exe'));

const libraw = () => process.env.LAMHAAT_LIBRAW || path.join(TOOLS, 'libraw', 'dcraw_emu.exe');
const pyRaw = () => fs.existsSync(python()) && fs.existsSync(path.join(TOOLS, 'py', 'rawpy'));
export const status = () => ({
  raw: fs.existsSync(libraw()) || pyRaw(),
  denoise: fs.existsSync(python()) && fs.existsSync(path.join(TOOLS, 'models', 'scunet_color_real_psnr.pth')),
});
export const developedPath = sha => path.join(DEV, `${sha}.jpg`);

// the picture to read for a photo: its developed copy if it is RAW, else the file itself
export function readable(file, sha = null) {
  if (!RAW.test(file)) return file;
  sha ??= db.prepare('SELECT sha256 FROM photos WHERE path = ?').get(file)?.sha256;
  return developedPath(sha);
}

// develop.py, for a list of jobs; onStep(job index, 0..1)
export function run(jobs, onStep = () => {}) {
  if (!fs.existsSync(python())) return Promise.reject(new Problem('nopython', 'The Python that runs the AI (ComfyUI’s) isn’t on this PC.'));
  const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-dev-')), 'jobs.json');
  fs.writeFileSync(list, JSON.stringify(jobs));
  return new Promise((resolve, reject) => {
    const child = spawn(python(), [path.join(import.meta.dirname, 'develop.py'), list], { windowsHide: true, env: { ...process.env, LAMHAAT_TOOLS: TOOLS, PYTHONIOENCODING: 'utf-8' } });
    const out = jobs.map(() => null);
    let buf = '', err = '';
    child.stdout.on('data', d => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        try { const m = JSON.parse(buf.slice(0, i)); if ('p' in m) onStep(m.i, m.p); else { out[m.i] = m; onStep(m.i, 1); } } catch {}
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', () => { fs.rmSync(path.dirname(list), { recursive: true, force: true }); out.every(Boolean) ? resolve(out) : reject(new Problem('develop', err.trim().split('\n').at(-1) || 'Developing stopped.')); });
  });
}

// a RAW file's developed picture, made if missing (with the AI's noise removal if asked)
export async function develop(file, sha, { denoise = false, force = false } = {}) {
  const out = developedPath(sha);
  if (fs.existsSync(out) && !force) return out;
  if (!status().raw) throw new Problem('noraw', 'RAW photos need the RAW reader (Settings → RAW photos).');
  fs.mkdirSync(DEV, { recursive: true });
  if (fs.existsSync(libraw()) && !(denoise && pyRaw())) return librawDevelop(file, out);
  const [r] = await run([{ in: file, out, raw: true, denoise }]);
  if (r.error) throw new Problem('develop', `Couldn’t develop ${path.basename(file)}: ${r.error}`);
  return out;
}

// LibRaw's developer: camera white balance, 16 bits, turned the right way, no noise reduction of its own
async function librawDevelop(file, out) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-raw-')), tif = path.join(tmp, 'dev.tiff');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(libraw(), ['-w', '-6', '-T', '-q', '3', '-Z', tif, file], { windowsHide: true });
      let err = '';
      child.stderr.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('close', code => code === 0 && fs.existsSync(tif) ? resolve() : reject(new Problem('develop', `Couldn’t develop ${path.basename(file)}: ${err.trim().split('\n').at(-1) || 'not a RAW file LibRaw knows'}`)));
    });
    await sharp(tif, { limitInputPixels: false }).toColourspace('srgb').jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toFile(`${out}.part`);
    fs.renameSync(`${out}.part`, out);
    return out;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// date, camera and settings of a RAW file. A Fuji RAF carries a JPEG with the full EXIF inside it
// (where it is and how long are written at bytes 84 and 88)
export async function exifOf(file, opts) {
  const direct = await exifr.parse(file, opts).catch(() => null);
  if (direct || !/\.raf$/i.test(file)) return direct;
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(92);
    fs.readSync(fd, head, 0, 92, 0);
    const at = head.readUInt32BE(84), len = head.readUInt32BE(88), jpeg = Buffer.alloc(len);
    fs.readSync(fd, jpeg, 0, len, at);
    return await exifr.parse(jpeg, opts).catch(() => null);
  } finally { fs.closeSync(fd); }
}
