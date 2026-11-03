// Checking a shoot: sharpness, motion and exposure for every photo, from a 1024px greyscale copy
// decoded straight from the original (JPEGs shrink while decoding, so this is quick even for 40MP files).
// Scores are kept per photo and only recomputed when the photo or the scoring method changes.
import sharp from 'sharp';
import crypto from 'node:crypto';
import path from 'node:path';
import { db } from './db.js';
import { scoreGrey, flagShoot, DEFAULTS, signature } from './score.js';
import { groupShoot } from './groups.js';
import { suggest } from './review.js';
import { metaFor } from './meta.js';
import { aiFor } from './ai.js';
import { readable } from './raw.js';

const VERSION = 2; // bump when score.js changes what is measured (2: fingerprints for duplicates and bursts)
const PARALLEL = 3;

db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    photo_id  INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    sha256    TEXT NOT NULL,
    version   INTEGER NOT NULL,
    sharpness REAL, coherence REAL, highs REAL, lows REAL
  );
`);
// columns added after the first release of this table
const have = new Set(db.prepare('PRAGMA table_info(scores)').all().map(c => c.name));
for (const [col, type] of [['dhash', 'TEXT'], ['tiny', 'BLOB'], ['rawsha', 'TEXT']]) if (!have.has(col)) db.exec(`ALTER TABLE scores ADD COLUMN ${col} ${type}`);

let running = null;
export const isAnalysing = () => running;

export function unscoredCount(folder) {
  return db.prepare(`SELECT count(*) n FROM photos p LEFT JOIN scores s ON s.photo_id = p.id
    WHERE p.folder = ? AND (s.photo_id IS NULL OR s.sha256 != p.sha256 OR s.version != ?)`).get(folder, VERSION).n;
}

export async function analyseFolder(folder, onProgress = () => {}) {
  if (running) throw new Error('A check is already running');
  running = folder;
  try {
    const todo = db.prepare(`SELECT p.id, p.path, p.name, p.sha256 FROM photos p LEFT JOIN scores s ON s.photo_id = p.id
      WHERE p.folder = ? AND (s.photo_id IS NULL OR s.sha256 != p.sha256 OR s.version != ?) ORDER BY p.id`).all(folder, VERSION);
    const r = { folder, phase: 'checking', total: todo.length, done: 0, errors: [], started: Date.now() };
    onProgress({ ...r });
    const save = db.prepare(`INSERT INTO scores (photo_id, sha256, version, sharpness, coherence, highs, lows, dhash, tiny, rawsha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(photo_id) DO UPDATE SET sha256 = excluded.sha256, version = excluded.version,
      sharpness = excluded.sharpness, coherence = excluded.coherence, highs = excluded.highs, lows = excluded.lows,
      dhash = excluded.dhash, tiny = excluded.tiny, rawsha = excluded.rawsha`);
    let next = 0;
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (next < todo.length) {
        const p = todo[next++];
        try {
          const { data, info } = await sharp(readable(p.path, p.sha256), { failOn: 'none' })
            .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
            .greyscale().raw().toBuffer({ resolveWithObject: true });
          const s = scoreGrey(data, info.width, info.height), sig = signature(data, info.width, info.height);
          const rawsha = crypto.createHash('sha256').update(data).digest('hex'); // identical once decoded = an exact copy
          save.run(p.id, p.sha256, VERSION, s.sharpness, s.coherence, s.highs, s.lows, sig.dhash, sig.tiny, rawsha);
        } catch (err) { r.errors.push({ file: p.name, error: String(err.message || err) }); }
        r.done++;
        onProgress({ ...r, current: p.name });
      }
    }));
    r.ms = Date.now() - r.started;
    return r;
  } finally {
    running = null;
  }
}

// Photos of a folder with their scores, flags and groups (all judged against the whole shoot).
export function photosWithFlags(folder) {
  const rows = db.prepare(`SELECT p.id, p.name, p.path, p.sha256, p.w, p.h, p.taken, p.camera, p.lens, p.iso, p.shutter, p.f, p.size, p.decision, p.lat, p.lon,
      s.sharpness, s.coherence, s.highs, s.lows, s.dhash, s.tiny, s.rawsha
    FROM photos p LEFT JOIN scores s ON s.photo_id = p.id AND s.sha256 = p.sha256 AND s.version = ?
    WHERE p.folder = ? ORDER BY coalesce(p.taken, ''), p.name`).all(VERSION, folder);
  const seen = aiFor(rows.map(r => r.id)); // the AI's view, including how sharp the subject is
  const flags = flagShoot(rows.map(r => ({ ...r, subjectSharp: seen.get(r.id)?.subjectSharp })), DEFAULTS);
  const sharp = rows.map(r => r.sharpness).filter(v => v != null).sort((a, b) => a - b);
  const median = sharp.length ? sharp[Math.floor(sharp.length / 2)] : null;
  // what the AI noticed (spec flags it can answer without another model), and high-ISO noise from the camera's own record;
  // a weak shot is one the AI scored in the bottom tenth of the shoot, and only ever a soft hint
  const beauties = [...seen.values()].map(s => s.aiSeen?.beauty).filter(Number.isFinite).sort((a, b) => a - b);
  const weakCut = beauties.length >= 10 ? Math.min(4, beauties[Math.floor(beauties.length * 0.1)]) : 0;
  const aiFlags = (r) => {
    const a = seen.get(r.id)?.aiSeen, out = [];
    if (a?.eyesClosed) out.push('eyes');
    if (a && a.kind !== 'photo') out.push('screenshot');
    if (a?.accident) out.push('accident');
    if (a?.tilted) out.push('tilted');
    if (a?.sensitive) out.push('sensitive');
    if (a?.beauty != null && a.beauty <= weakCut) out.push('weak');
    if (r.iso >= 6400) out.push('noisy');
    return out;
  };
  const photos = rows.map(({ path: full, ...r }, i) => ({ ...r, rel: path.relative(folder, full), flags: [...flags[i], ...aiFlags(r)], subjectSharp: seen.get(r.id)?.subjectSharp ?? null }));
  const groups = groupShoot(photos);
  const inGroup = new Map();
  for (const g of groups) g.ids.forEach((id, i) => inGroup.set(id, { group: g.id, kind: g.kind, size: g.ids.length, at: i + 1, isPick: id === g.pick }));
  const suggested = suggest(photos, groups);
  // fingerprints stay on this side; the window only needs the results
  const meta = metaFor(photos.map(p => p.id));
  const ev = e => e ? crypto.createHash('sha1').update(JSON.stringify(e)).digest('hex').slice(0, 10) : null; // names the edited thumbnail
  return { photos: photos.map(({ tiny, dhash, rawsha, ...p }) => { const m = meta.get(p.id); return { ...p, ...inGroup.get(p.id), ...suggested.get(p.id), ...m, ...seen.get(p.id), ev: ev(m.edits) }; }), groups, median };
}
