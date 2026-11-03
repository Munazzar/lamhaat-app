// Making photos bigger or sharper, on this PC. With Real-ESRGAN (an AI model that runs on the graphics
// card; one 45 MB download, only when you ask for it) the picture is redrawn at 4x and brought to the size
// you chose; without it, a careful resize and sharpen. The original is never changed: the result is a new
// photo in the shoot's "Enhanced" folder, with the original's date and camera, so it sits next to it.
//   mode  x2 / x4: that many times wider and taller (at most 120 megapixels)
//         fix: the same size, redrawn: soft or noisy photos come out cleaner
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import sharp from 'sharp';
import { dataDir } from './db.js';
import { Problem } from './github.js';
import { readable } from './raw.js';

const TOOL = path.join(dataDir, 'tools', 'realesrgan');
const exe = () => process.env.LAMHAAT_UPSCALER || path.join(TOOL, 'realesrgan-ncnn-vulkan.exe');
const ZIP = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip';
export const MODES = { x2: { scale: 2, label: '2x' }, x4: { scale: 4, label: '4x' }, fix: { scale: 1, label: 'sharpened' } };
const AI_DETAIL = 0.5; // how much of the AI's detail goes on top of the photo (see enhance)
const MAX_OUT = 120e6, MAX_MID = 128e6; // pixels: the result, and the AI's 4x picture before it is resized

let installing = null;
export const status = () => ({ ai: fs.existsSync(exe()), installing, size: '45 MB' });

// the result's size for a photo w x h (as shown, after turning)
export function target(w, h, mode) {
  const s = Math.min(MODES[mode].scale, Math.sqrt(MAX_OUT / (w * h)));
  return { w: Math.max(1, Math.round(w * Math.max(1, s))), h: Math.max(1, Math.round(h * Math.max(1, s))) };
}

// EXIF date as the camera writes it: local time
const exifDate = iso => { const d = new Date(iso), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const run = (file, args, onLine) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { windowsHide: true });
  let err = '';
  child.stderr.on('data', d => { err += d; for (const l of String(d).split(/\r?\n/)) if (l.trim()) onLine(l.trim()); });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(err.split('\n').filter(Boolean).at(-1) || `stopped (${code})`)));
});

// photo: { path, name, folder, w, h, taken, camera }
export async function enhance(photo, mode, { ai = status().ai, onProgress = () => {} } = {}) {
  if (!MODES[mode]) throw new Problem('mode', 'Unknown enhancement.');
  const t = target(photo.w, photo.h, mode);
  const base = path.parse(photo.name).name;
  const dir = path.join(photo.folder, 'Enhanced');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${base} (${ai ? 'AI ' : ''}${MODES[mode].label}).jpg`);
  const [make, ...model] = String(photo.camera || '').split(' ');
  const exif = { IFD0: { Software: 'Lamhaat', ...(photo.camera && { Make: make, Model: model.join(' ') || make }) }, ...(photo.taken && { IFD2: { DateTimeOriginal: exifDate(photo.taken) } }) };
  let pic;
  if (ai) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-up-'));
    try {
      // the AI's input: small enough that its 4x picture stays under MAX_MID pixels
      const s = Math.min(1, Math.sqrt(MAX_MID / (16 * photo.w * photo.h)));
      await sharp(readable(photo.path), { failOn: 'none' }).rotate().resize(Math.round(photo.w * s), Math.round(photo.h * s)).png().toFile(path.join(tmp, 'in.png'));
      await run(exe(), ['-i', path.join(tmp, 'in.png'), '-o', path.join(tmp, 'out.png'), '-n', 'realesrgan-x4plus', '-s', '4', '-f', 'png'],
        l => { const m = /([\d.]+)%/.exec(l); if (m) onProgress(Number(m[1]) / 100); });
      // Alone, the AI repaints fine texture (leaves, grass) as brush strokes and dulls the colour. So the
      // photo itself, enlarged carefully, is the base, and only half of the AI's light-and-dark detail is
      // added on top: colour and texture stay the camera's, edges get the AI's crispness.
      const [ai, base] = await Promise.all([
        sharp(path.join(tmp, 'out.png'), { limitInputPixels: false }).resize(t.w, t.h, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer(),
        sharp(readable(photo.path), { failOn: 'none', limitInputPixels: false }).rotate().resize(t.w, t.h, { kernel: 'lanczos3' }).removeAlpha().toColourspace('srgb').raw().toBuffer()]);
      for (let i = 0; i < base.length; i += 3) {
        const d = AI_DETAIL * (0.299 * (ai[i] - base[i]) + 0.587 * (ai[i + 1] - base[i + 1]) + 0.114 * (ai[i + 2] - base[i + 2]));
        base[i] = Math.max(0, Math.min(255, base[i] + d)); base[i + 1] = Math.max(0, Math.min(255, base[i + 1] + d)); base[i + 2] = Math.max(0, Math.min(255, base[i + 2] + d));
      }
      pic = await sharp(base, { raw: { width: t.w, height: t.h, channels: 3 }, limitInputPixels: false }).jpeg({ quality: 94, mozjpeg: true }).withExif(exif).toBuffer();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } else {
    pic = await sharp(readable(photo.path), { failOn: 'none' }).rotate().resize(t.w, t.h, { kernel: 'lanczos3' })
      .sharpen({ sigma: mode === 'fix' ? 1.2 : 0.8 }).jpeg({ quality: 94, mozjpeg: true }).withExif(exif).toBuffer();
  }
  fs.writeFileSync(`${out}.part`, pic);
  fs.renameSync(`${out}.part`, out);
  onProgress(1);
  return { file: out, ...t };
}

// one download, unpacked into the library's tools folder
export async function install(onProgress = () => {}) {
  if (status().ai) return status();
  if (installing) throw new Problem('busy', 'Already downloading.');
  installing = { done: 0, total: 45474481 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-esrgan-'));
  try {
    const res = await fetch(ZIP).catch(() => null);
    if (!res?.ok) throw new Problem('offline', 'Couldn’t download the upscaler. Check the internet connection.');
    const zip = path.join(tmp, 'esrgan.zip'), file = fs.createWriteStream(zip);
    for await (const chunk of res.body) { file.write(chunk); installing.done += chunk.length; onProgress({ ...installing }); }
    await new Promise(r => file.end(r));
    await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${path.join(tmp, 'x')}' -Force`], { windowsHide: true }, e => e ? reject(e) : resolve()));
    const found = fs.readdirSync(path.join(tmp, 'x'), { recursive: true }).find(f => f.endsWith('realesrgan-ncnn-vulkan.exe'));
    if (!found) throw new Problem('broken', 'The download didn’t have the upscaler in it.');
    fs.rmSync(TOOL, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(TOOL), { recursive: true });
    fs.cpSync(path.dirname(path.join(tmp, 'x', found)), TOOL, { recursive: true });
    installing = null; // done: say so in the answer
    return status();
  } finally { installing = null; fs.rmSync(tmp, { recursive: true, force: true }); }
}
