// Search by meaning, the library's side: each photo's numbers (site/meaning.js), worked out in Lamhaat's
// window (it is a browser, so the same small model runs there as on the site) and kept here with a
// fingerprint of the words they came from. When a photo's words change, its numbers are worked out again.
import crypto from 'node:crypto';
import { db } from './db.js';
import { metaFor, allTags } from './meta.js';
import { aiFor } from './ai.js';
import { photoText } from '../site/meaning.js';

db.exec(`CREATE TABLE IF NOT EXISTS photo_embed (
  photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,   -- of the words it was made from
  vec TEXT NOT NULL     -- 384 numbers, packed (meaning.js pack)
)`);

// the words for each photo, as the site will see them (names, not ids)
export function textsFor(ids) {
  const meta = metaFor(ids), seen = aiFor(ids), names = new Map(allTags().map(t => [t.id, t]));
  return new Map(ids.map(id => {
    const m = meta.get(id), a = seen.get(id) || {}, tags = m.tags.map(t => names.get(t)).filter(Boolean);
    const text = photoText({ title: m.title, description: m.description, people: tags.filter(t => t.kind === 'person').map(t => t.name),
      tagNames: tags.filter(t => t.kind === 'tag').map(t => t.name), aiDescription: a.aiDescription, aiTags: a.aiTags });
    return [id, { text, hash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 16) }];
  }));
}

// photos of a shoot (not rejected) with words but no numbers for those words yet
export function todo(folder) {
  const ids = db.prepare("SELECT id FROM photos WHERE folder = ? AND decision != 'reject'").all(folder).map(r => r.id);
  const have = new Map(db.prepare(`SELECT photo_id, hash FROM photo_embed WHERE photo_id IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids).map(r => [r.photo_id, r.hash]));
  return [...textsFor(ids)].filter(([id, t]) => t.text && have.get(id) !== t.hash).map(([id, t]) => ({ id, text: t.text, hash: t.hash }));
}

const put = db.prepare('INSERT INTO photo_embed (photo_id, hash, vec) VALUES (?, ?, ?) ON CONFLICT(photo_id) DO UPDATE SET hash = excluded.hash, vec = excluded.vec');
export function save(items) {
  let n = 0;
  for (const it of items) if (Number.isInteger(it.id) && /^[0-9a-f]{16}$/.test(it.hash) && /^[A-Za-z0-9+/]{512}$/.test(it.vec)) { put.run(it.id, it.hash, it.vec); n++; }
  return n;
}

// the numbers for photos whose words haven't changed since (for publishing)
export function forPublish(ids) {
  if (!ids.length) return new Map();
  const texts = textsFor(ids);
  return new Map(db.prepare(`SELECT photo_id, hash, vec FROM photo_embed WHERE photo_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    .filter(r => texts.get(r.photo_id)?.hash === r.hash).map(r => [r.photo_id, r.vec]));
}
