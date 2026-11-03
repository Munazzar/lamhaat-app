// Importing a shoot: for every photo in a folder (and its subfolders) record what it is, when and how
// it was taken, a SHA-256 of the original for identity, and a small preview for the screen.
// Re-importing is cheap: files whose size and modified time haven't changed are skipped.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import exifr from 'exifr';
import { db, previewPath, setting } from './db.js';
import * as raw from './raw.js';

const PHOTO = /\.(jpe?g|png|webp|tiff?|avif|heic|heif)$/i;
// Not committed to GitHub in v1 (spec section 5): noted, never imported. RAW files too, until the RAW
// reader is installed; then they are developed (raw.js) and come in like any photo.
const SKIPPED = /\.(mp4|mov|avi|mkv|m4v|3gp|webm)$/i;
const PARALLEL = 3;

sharp.cache(false); // every file is read once; caching only costs memory
// where a photo was taken, when the camera or phone recorded it (added after the first release)
if (!db.prepare('PRAGMA table_info(photos)').all().some(c => c.name === 'lat')) db.exec('ALTER TABLE photos ADD COLUMN lat REAL; ALTER TABLE photos ADD COLUMN lon REAL;');

export function listPhotos(dir) {
  const photos = [], skipped = [], rawOk = raw.status().raw;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    const full = path.join(e.parentPath, e.name);
    if (PHOTO.test(e.name) || (rawOk && raw.RAW.test(e.name))) photos.push(full);
    else if (SKIPPED.test(e.name) || raw.RAW.test(e.name)) skipped.push(full);
  }
  return { photos: photos.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), skipped };
}

const sha256 = file => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
});

const shutter = t => !t ? null : t >= 1 ? `${+t.toFixed(1)}s` : `1/${Math.round(1 / t)}`;

async function readOne(file) {
  const st = fs.statSync(file);
  const old = db.prepare('SELECT sha256, size, mtime FROM photos WHERE path = ?').get(file);
  if (old && old.size === st.size && old.mtime === st.mtimeMs && fs.existsSync(previewPath(old.sha256))) return 'unchanged';

  const hash = await sha256(file);
  const isRaw = raw.RAW.test(file);
  // a RAW file is developed first (already turned the right way up); the rest reads that picture
  const src = isRaw ? await raw.develop(file, hash, { denoise: setting('denoiseRaw') === 'yes' && raw.status().denoise }) : file;
  const meta = await sharp(src, { failOn: 'none' }).metadata();
  const turned = (meta.orientation || 1) >= 5; // EXIF orientations 5-8 swap width and height
  const opts = { gps: true, pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'LensModel', 'ISO', 'ExposureTime', 'FNumber', 'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'] };
  const ex = (isRaw ? await raw.exifOf(file, opts) : await exifr.parse(file, opts).catch(() => null)) || {};
  const taken = ex.DateTimeOriginal || ex.CreateDate;
  if (!fs.existsSync(previewPath(hash))) {
    // write to a temp name first so a crash never leaves a half-written preview that looks complete
    const tmp = previewPath(hash) + '.part';
    await sharp(src, { failOn: 'none' }).rotate().resize(720, 720, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toFile(tmp);
    fs.renameSync(tmp, previewPath(hash));
  }
  const camera = [ex.Make, ex.Model].filter(Boolean).join(' ').replace(/^(\S+) \1 /i, '$1 ').trim() || null;
  db.prepare(`
    INSERT INTO photos (folder, path, name, size, mtime, sha256, w, h, taken, camera, lens, iso, shutter, f, lat, lon)
    VALUES (:folder, :path, :name, :size, :mtime, :sha, :w, :h, :taken, :camera, :lens, :iso, :shutter, :f, :lat, :lon)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, sha256 = excluded.sha256, w = excluded.w, h = excluded.h,
      taken = excluded.taken, camera = excluded.camera, lens = excluded.lens, iso = excluded.iso, shutter = excluded.shutter, f = excluded.f,
      lat = excluded.lat, lon = excluded.lon
  `).run({
    folder: importing, path: file, name: path.basename(file), size: st.size, mtime: st.mtimeMs, sha: hash,
    w: turned ? meta.height : meta.width, h: turned ? meta.width : meta.height,
    taken: taken instanceof Date && !isNaN(taken) ? taken.toISOString() : null,
    camera, lens: ex.LensModel || null, iso: ex.ISO ?? null, shutter: shutter(ex.ExposureTime), f: ex.FNumber ?? null,
    ...gps(ex),
  });
  return old ? 'updated' : 'added';
}

// a real position only: (0, 0) is what some phones write when they had no fix
const gps = ex => Number.isFinite(ex.latitude) && Number.isFinite(ex.longitude) && (ex.latitude || ex.longitude) ? { lat: ex.latitude, lon: ex.longitude } : { lat: null, lon: null };

let importing = null; // one import at a time

export async function importFolder(dir, onProgress = () => {}) {
  if (importing) throw new Error('An import is already running');
  dir = path.resolve(dir);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a folder: ${dir}`);
  importing = dir;
  try {
    db.prepare('INSERT INTO folders (path) VALUES (?) ON CONFLICT(path) DO NOTHING').run(dir);
    const { photos, skipped } = listPhotos(dir);
    const r = { folder: dir, total: photos.length, done: 0, added: 0, updated: 0, unchanged: 0, removed: 0, errors: [], skipped: skipped.length, started: Date.now() };
    onProgress({ ...r });
    let next = 0;
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (next < photos.length) {
        const file = photos[next++];
        try { r[await readOne(file)]++; }
        catch (err) { r.errors.push({ file: path.basename(file), error: String(err.message || err) }); }
        r.done++;
        onProgress({ ...r, current: path.basename(file) });
      }
    }));
    // photos deleted from disk since the last import leave the library too (decisions go with them)
    const present = new Set(photos);
    for (const row of db.prepare('SELECT path FROM photos WHERE folder = ?').all(dir)) {
      if (!present.has(row.path)) { db.prepare('DELETE FROM photos WHERE path = ?').run(row.path); r.removed++; }
    }
    db.prepare('UPDATE folders SET imported_at = ? WHERE path = ?').run(new Date().toISOString(), dir);
    r.ms = Date.now() - r.started;
    return r;
  } finally {
    importing = null;
  }
}

export const isImporting = () => importing;
