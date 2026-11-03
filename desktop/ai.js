// Local AI, with a vision model already on this PC (Ollama, qwen2.5vl:7b by default): nothing leaves
// the computer. Three jobs:
//   describe  a sentence, a few suggested tags, how many people and where the main subject is, for every
//             photo (search uses it too). The subject's own sharpness is then measured from the original,
//             so a sharp background can't hide a soft face. A run can carry the owner's own instructions.
//   find      once you tag a person, every other photo of the shoot with people in it is compared with
//             the photos you tagged, asked both ways round; when both answers say "same person", the
//             photo is tagged automatically (marked as auto). Removing an auto tag tells it "not them":
//             that photo is never auto-tagged with that person again.
//   search    words matched against descriptions, suggested and your own tags, titles and people
// Results are kept per photo and model, so nothing is asked twice.
import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { db, setting, previewPath } from './db.js';
import { Problem } from './github.js';
import { scoreGrey } from './score.js';
import { readable } from './raw.js';
import { startOllama } from './tools.js';
import './meta.js'; // its tables (tags, photo_tags) first: the ones below refer to them

const OLLAMA = () => setting('ollama', 'http://127.0.0.1:11434');
export const MODEL = () => setting('visionModel', 'qwen2.5vl:7b');
const ASKING = 3; // bump when the describe question changes, so photos are described again (3: subject box, eyes, kind, accident, tilt, sensitive, beauty)
const KEY = () => `${MODEL()}#${ASKING}`;

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_photo (
    photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL, model TEXT NOT NULL,
    description TEXT, tags TEXT NOT NULL DEFAULT '[]', people INTEGER, at TEXT
  );
  CREATE TABLE IF NOT EXISTS ai_match (
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    refs TEXT NOT NULL,          -- which tagged photos it was compared with
    model TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('match', 'no', 'dismissed')),
    PRIMARY KEY (tag_id, photo_id)
  );
`);
// tags the AI added carry a mark, so they can be shown and taken back
if (!db.prepare('PRAGMA table_info(photo_tags)').all().some(c => c.name === 'auto')) db.exec('ALTER TABLE photo_tags ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');
// the main subject's box (fractions of the frame), how sharp it is there, and the instructions the run had
if (!db.prepare('PRAGMA table_info(ai_photo)').all().some(c => c.name === 'subject')) db.exec('ALTER TABLE ai_photo ADD COLUMN subject TEXT; ALTER TABLE ai_photo ADD COLUMN subject_sharp REAL; ALTER TABLE ai_photo ADD COLUMN note TEXT;');
if (!db.prepare('PRAGMA table_info(ai_photo)').all().some(c => c.name === 'extra')) db.exec('ALTER TABLE ai_photo ADD COLUMN extra TEXT;'); // eyes, kind, accident, tilt, sensitive, beauty

// ---------- talking to Ollama ----------
export async function ready() {
  const tags = () => fetch(`${OLLAMA()}/api/tags`, { signal: AbortSignal.timeout(4000) }).then(r => r.json());
  let t = await tags().catch(() => null);
  if (!t && await startOllama()) t = await tags().catch(() => null); // stopped: start it, then ask again
  if (!t) throw new Problem('noollama', 'The AI server (Ollama) isn’t installed or won’t start. Settings → Programs Lamhaat uses.');
  if (!t.models?.some(m => m.name === MODEL() || m.model === MODEL())) throw new Problem('nomodel', `The vision model ${MODEL()} isn’t downloaded yet. Settings → Programs Lamhaat uses.`);
  return true;
}
const image = sha => fs.readFileSync(previewPath(sha)).toString('base64');
async function ask(prompt, shas, { json = false, images = null } = {}, again = true) {
  let r;
  try {
    r = await fetch(`${OLLAMA()}/api/generate`, { method: 'POST', signal: AbortSignal.timeout(180e3), body: JSON.stringify({
      model: MODEL(), prompt, images: images || shas.map(image), stream: false, keep_alive: '10m', ...(json && { format: 'json' }), options: { temperature: 0 } }) }).then(r => r.json());
  } catch {
    if (again && await startOllama()) return ask(prompt, shas, { json, images }, false); // it stopped: start it and ask once more
    throw new Problem('noollama', 'Lost the connection to the AI server (Ollama), and it won’t start again.');
  }
  if (r.error) throw new Problem('ollama', `Ollama said: ${r.error}`);
  return r.response || '';
}

// ---------- describe ----------
const DESCRIBE = (w, h, note) => `This photo (${w} x ${h} pixels) is from a family photo library. Reply only with JSON like {"description": "...", "tags": ["..."], "people": 0, "subject": [x1, y1, x2, y2], "eyes_closed": false, "kind": "photo", "accident": false, "tilted": false, "sensitive": false, "beauty": 5}. `
  + 'description: one plain sentence saying what is in the photo, without guessing names. tags: 3 to 8 short lowercase words or phrases '
  + '(place, things, activity, season, weather, mood). people: how many people are visible, counting babies and children too. '
  + 'subject: the pixel box around the main subject; for people, around their faces only. '
  + 'eyes_closed: true only if someone awake has their eyes shut, as in a blink (not someone sleeping). '
  + 'kind: "photo", or "screenshot", "document" or "receipt" if that is what it is. '
  + 'accident: true if it looks taken by mistake (inside a pocket, a finger over the lens, the ground or a blank frame). '
  + 'tilted: true if a horizon or building is clearly not level by mistake. '
  + 'sensitive: true if it shows nudity, or private papers such as an ID card, passport, bank card or medical record. '
  + 'beauty: 1 to 10, how good the photograph is (light, composition, moment).'
  + (note ? ` The owner adds, for this run: ${note}` : '');
export function cleanDescribe(text, size = null) {
  let j = {};
  try { j = JSON.parse(text); } catch { const m = /\{[\s\S]*\}/.exec(text); try { j = m ? JSON.parse(m[0]) : {}; } catch {} }
  const tags = [...new Set((Array.isArray(j.tags) ? j.tags : String(j.tags || '').split(','))
    .map(t => String(t).toLowerCase().replace(/[^\p{L}\p{N} &'-]/gu, '').trim()).filter(t => t && t.length <= 40))].slice(0, 8);
  const people = Number.isFinite(Number(j.people)) ? Math.max(0, Math.min(99, Math.round(Number(j.people)))) : null;
  // the subject's box as fractions of the frame; none if the answer has no box that makes sense
  const b = Array.isArray(j.subject) && j.subject.length === 4 && j.subject.every(Number.isFinite) ? j.subject : null;
  const box = b && size ? [b[0] / size.w, b[1] / size.h, b[2] / size.w, b[3] / size.h].map(v => Math.max(0, Math.min(1, v))) : null;
  const subject = box && box[2] - box[0] > 0.02 && box[3] - box[1] > 0.02 ? box.map(v => Math.round(v * 1000) / 1000) : null;
  // what else it noticed: only clear yes/no answers and a 1-10 score count; anything else is left out
  const yes = v => v === true || v === 'true', kind = ['screenshot', 'document', 'receipt'].includes(j.kind) ? j.kind : 'photo';
  const beauty = Number.isFinite(Number(j.beauty)) ? Math.max(1, Math.min(10, Math.round(Number(j.beauty)))) : null;
  const extra = { eyesClosed: yes(j.eyes_closed), kind, accident: yes(j.accident), tilted: yes(j.tilted), sensitive: yes(j.sensitive), beauty };
  return { description: String(j.description || '').trim().slice(0, 400), tags, people, subject, extra };
}
const save = db.prepare(`INSERT INTO ai_photo (photo_id, sha256, model, description, tags, people, at, subject, subject_sharp, note, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(photo_id) DO UPDATE SET sha256 = excluded.sha256, model = excluded.model, description = excluded.description, tags = excluded.tags,
    people = excluded.people, at = excluded.at, subject = excluded.subject, subject_sharp = excluded.subject_sharp, note = excluded.note, extra = excluded.extra`);
export const undescribed = folder => db.prepare(`SELECT p.id, p.name, p.sha256, p.path FROM photos p LEFT JOIN ai_photo a ON a.photo_id = p.id
  WHERE p.folder = ? AND p.decision != 'reject' AND (a.photo_id IS NULL OR a.sha256 != p.sha256 OR a.model != ?) ORDER BY coalesce(p.taken, ''), p.name`).all(folder, KEY());
export function aiFor(ids) {
  const out = new Map();
  if (!ids.length) return out;
  for (const r of db.prepare(`SELECT photo_id, description, tags, people, subject, subject_sharp, extra FROM ai_photo WHERE photo_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
    out.set(r.photo_id, { aiDescription: r.description, aiTags: JSON.parse(r.tags), aiPeople: r.people, subject: r.subject ? JSON.parse(r.subject) : null, subjectSharp: r.subject_sharp, aiSeen: r.extra ? JSON.parse(r.extra) : null });
  }
  return out;
}

// ---------- jobs: one at a time, since they share the graphics card ----------
let job = null;
export const aiJob = () => job && { kind: job.kind, folder: job.folder, done: job.done, total: job.total, person: job.person };
export const cancelAi = () => { if (job) job.cancel = true; };
async function runJob(kind, folder, list, each, onProgress, extra = {}) {
  if (job) throw new Problem('busy', 'The AI is already working. One job at a time.');
  await ready();
  job = { kind, folder, done: 0, total: list.length, cancel: false, started: Date.now(), errors: 0, ...extra };
  try {
    for (const item of list) {
      if (job.cancel) break;
      try { await each(item); } catch (e) { if (e.kind === 'noollama') throw e; job.errors++; }
      job.done++;
      onProgress({ ...aiJob(), errors: job.errors });
    }
    return { ...aiJob(), errors: job.errors, cancelled: job.cancel, ms: Date.now() - job.started };
  } finally { job = null; }
}

// how sharp the subject is: measured like the whole-photo check (score.js), inside its box only
export async function subjectSharpness(file, box) {
  const { data, info } = await sharp(file, { failOn: 'none' }).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const w = Math.min(W, Math.max(32, Math.round((box[2] - box[0]) * W))), h = Math.min(H, Math.max(32, Math.round((box[3] - box[1]) * H)));
  const x0 = Math.max(0, Math.min(W - w, Math.round(box[0] * W))), y0 = Math.max(0, Math.min(H - h, Math.round(box[1] * H)));
  const crop = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) crop.set(data.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + w), y * w);
  return scoreGrey(crop, w, h).sharpness;
}
// every photo not described yet; or, with `ids`, these again, with the owner's instructions for the run
export function describeFolder(folder, onProgress = () => {}, { ids = null, note = '' } = {}) {
  const list = ids ? db.prepare(`SELECT id, name, sha256, path FROM photos WHERE folder = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY coalesce(taken, ''), name`).all(folder, ...ids) : undescribed(folder);
  return runJob('describe', folder, list, async p => {
    // 1280 px from the original: Ollama enlarges smaller pictures before the model sees them, and then the
    // subject's box comes back in the enlarged picture's pixels; at this size they are the picture's own
    const { data, info } = await sharp(readable(p.path, p.sha256), { failOn: 'none' }).rotate().resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
    const r = cleanDescribe(await ask(DESCRIBE(info.width, info.height, note), [], { json: true, images: [data.toString('base64')] }), { w: info.width, h: info.height });
    const sharpness = r.subject ? await subjectSharpness(readable(p.path, p.sha256), r.subject).catch(() => null) : null;
    save.run(p.id, p.sha256, KEY(), r.description, JSON.stringify(r.tags), r.people, new Date().toISOString(), r.subject && JSON.stringify(r.subject), sharpness, note || null, JSON.stringify(r.extra));
  }, onProgress);
}

// ---------- find a person ----------
const SAME = 'Look only at the adult or child faces. Is a person in the first photo the same individual as a person in the second photo? '
  + 'Judge by facial features, not clothes or setting. Answer only yes or no.';
export async function samePerson(a, b) {
  const yes = t => /^\W*yes/i.test(t);
  if (!yes(await ask(SAME, [a, b]))) return false;
  return yes(await ask(SAME, [b, a])); // both ways round, or it isn't a match
}
const PERSON = /\b(baby|babies|newborn|infant|toddler|child|children|kid|kids|girl|boy|man|men|woman|women|person|people|family|mother|father|face|faces|someone|lady|gentleman|couple|portrait|selfie)\b/i;
// the photos YOU tagged with this person here (never the AI's own): up to 3, the sharpest first
const refsOf = (folder, tagId) => db.prepare(`SELECT p.id, p.sha256 FROM photos p JOIN photo_tags t ON t.photo_id = p.id AND t.tag_id = ? AND t.auto = 0
  LEFT JOIN scores s ON s.photo_id = p.id WHERE p.folder = ? ORDER BY coalesce(s.sharpness, 0) DESC LIMIT 3`).all(tagId, folder);
// the people tagged by hand in a shoot: what "find" runs for
export const peopleIn = folder => db.prepare(`SELECT DISTINCT t.id FROM tags t JOIN photo_tags pt ON pt.tag_id = t.id AND pt.auto = 0
  JOIN photos p ON p.id = pt.photo_id WHERE t.kind = 'person' AND p.folder = ?`).all(folder).map(r => r.id);
export function findPerson(folder, tagId, onProgress = () => {}) {
  const refs = refsOf(folder, tagId);
  if (!refs.length) throw new Problem('norefs', 'Tag this person in at least one photo of this shoot first.');
  const refKey = refs.map(r => r.sha256.slice(0, 12)).sort().join(',');
  // photos with people in them (counted, or a person mentioned in the description), not yet tagged with
  // this person, not already asked with these photos
  const list = db.prepare(`SELECT p.id, p.sha256, a.people, a.description FROM photos p JOIN ai_photo a ON a.photo_id = p.id
    LEFT JOIN photo_tags t ON t.photo_id = p.id AND t.tag_id = ?
    LEFT JOIN ai_match m ON m.photo_id = p.id AND m.tag_id = ?
    WHERE p.folder = ? AND p.decision != 'reject' AND t.photo_id IS NULL
      AND (m.photo_id IS NULL OR (m.result != 'dismissed' AND (m.refs != ? OR m.model != ?)))
    ORDER BY coalesce(p.taken, ''), p.name`).all(tagId, tagId, folder, refKey, MODEL())
    .filter(p => p.people !== 0 || PERSON.test(p.description || ''));
  const name = db.prepare('SELECT name FROM tags WHERE id = ?').get(tagId)?.name;
  const put = db.prepare(`INSERT INTO ai_match (tag_id, photo_id, refs, model, result) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tag_id, photo_id) DO UPDATE SET refs = excluded.refs, model = excluded.model, result = excluded.result`);
  const tag = db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id, auto) VALUES (?, ?, 1)');
  const tagged = [];
  return runJob('find', folder, list, async p => {
    let hit = false;
    for (const r of refs) if (await samePerson(r.sha256, p.sha256)) { hit = true; break; }
    put.run(tagId, p.id, refKey, MODEL(), hit ? 'match' : 'no');
    if (hit && tag.run(p.id, tagId).changes) tagged.push(p.id); // tagged by itself, marked as auto
  }, p => onProgress({ ...p, tagged: tagged.length }), { person: name, tagId }).then(r => ({ ...r, tagged }));
}
// an auto tag taken off means "not this person": never added to that photo again
export function notThem(tagId, photoIds) {
  const q = db.prepare(`INSERT INTO ai_match (tag_id, photo_id, refs, model, result) VALUES (?, ?, '', '', 'dismissed')
    ON CONFLICT(tag_id, photo_id) DO UPDATE SET result = 'dismissed'`);
  for (const id of photoIds) q.run(tagId, id);
}

// ---------- search ----------
// every word must match somewhere (a plural matches its singular); more matches rank higher
export function searchScore(p, query, tagName = () => null) {
  const words = String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1).map(w => w.replace(/(?<=..)(es|s)$/, ''));
  if (!words.length) return 0;
  const text = [p.title, p.description, p.aiDescription, ...(p.aiTags || []), ...(p.tags || []).map(tagName), p.name, p.camera].filter(Boolean).join(' ').toLowerCase();
  let score = 0;
  for (const w of words) { const n = text.split(w).length - 1; if (!n) return 0; score += n; }
  return score;
}
