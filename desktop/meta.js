// What you add to photos: a title and description, tags and people (one library of names, reused
// everywhere), and edits. Edits are only settings; the original files are never changed.
import { db } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL DEFAULT 'tag' CHECK (kind IN ('tag', 'person')),
    UNIQUE (name, kind)
  );
  CREATE TABLE IF NOT EXISTS photo_tags (
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (photo_id, tag_id)
  );
  CREATE INDEX IF NOT EXISTS photo_tags_tag ON photo_tags(tag_id);
  CREATE TABLE IF NOT EXISTS photo_meta (
    photo_id    INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    title       TEXT,
    description TEXT,
    edits       TEXT
  );
`);

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

export const allTags = () => db.prepare(`SELECT t.id, t.name, t.kind, count(pt.photo_id) n FROM tags t
  LEFT JOIN photo_tags pt ON pt.tag_id = t.id GROUP BY t.id ORDER BY t.kind, t.name`).all();

// title, description, tag ids and edits for a set of photos, by id
export function metaFor(ids) {
  const out = new Map(ids.map(id => [id, { title: '', description: '', tags: [], edits: null }]));
  if (!ids.length) return out;
  const marks = ids.map(() => '?').join(',');
  for (const r of db.prepare(`SELECT photo_id, title, description, edits FROM photo_meta WHERE photo_id IN (${marks})`).all(...ids)) {
    Object.assign(out.get(r.photo_id), { title: r.title || '', description: r.description || '', edits: r.edits ? JSON.parse(r.edits) : null });
  }
  const hasAuto = db.prepare('PRAGMA table_info(photo_tags)').all().some(c => c.name === 'auto');
  for (const r of db.prepare(`SELECT photo_id, tag_id${hasAuto ? ', auto' : ', 0 auto'} FROM photo_tags WHERE photo_id IN (${marks})`).all(...ids)) {
    out.get(r.photo_id).tags.push(r.tag_id);
    if (r.auto) (out.get(r.photo_id).autoTags ||= []).push(r.tag_id); // added by the AI
  }
  return out;
}

const upsertMeta = db.prepare(`INSERT INTO photo_meta (photo_id, title, description, edits) VALUES (:id, :title, :description, :edits)
  ON CONFLICT(photo_id) DO UPDATE SET title = coalesce(:title, title), description = coalesce(:description, description), edits = CASE WHEN :clearEdits THEN NULL ELSE coalesce(:edits, edits) END`);
export function setText(id, { title, description }) {
  upsertMeta.run({ id, title: title == null ? null : clip(title, 140), description: description == null ? null : String(description).trim().slice(0, 2000), edits: null, clearEdits: 0 });
}
export function setEdits(id, edits) {
  upsertMeta.run({ id, title: null, description: null, edits: edits ? JSON.stringify(edits) : null, clearEdits: edits ? 0 : 1 });
}

// add a tag (made if new) to photos, or take one off
export function tagPhotos(ids, { name, kind = 'tag', tagId, remove = false }) {
  return tx(() => {
    let id = tagId;
    if (!id) {
      name = clip(name, 60);
      if (!name) throw new Error('A tag needs a name.');
      db.prepare('INSERT INTO tags (name, kind) VALUES (?, ?) ON CONFLICT(name, kind) DO NOTHING').run(name, kind);
      id = db.prepare('SELECT id FROM tags WHERE name = ? AND kind = ?').get(name, kind).id;
    }
    // tagging by hand makes a tag yours, even if the AI had added it
    const q = db.prepare(remove ? 'DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?'
      : (db.prepare('PRAGMA table_info(photo_tags)').all().some(c => c.name === 'auto') ? 'INSERT INTO photo_tags (photo_id, tag_id) VALUES (?, ?) ON CONFLICT DO UPDATE SET auto = 0' : 'INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)'));
    for (const p of ids) q.run(p, id);
    return id;
  });
}
// rename; if the new name already exists, the two become one
export function renameTag(id, name) {
  name = clip(name, 60);
  if (!name) throw new Error('A tag needs a name.');
  return tx(() => {
    const t = db.prepare('SELECT kind FROM tags WHERE id = ?').get(id);
    if (!t) throw new Error('That tag is gone.');
    const same = db.prepare('SELECT id FROM tags WHERE name = ? AND kind = ? AND id != ?').get(name, t.kind, id);
    if (same) {
      db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) SELECT photo_id, ? FROM photo_tags WHERE tag_id = ?').run(same.id, id);
      db.prepare('DELETE FROM tags WHERE id = ?').run(id);
      return same.id;
    }
    db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
    return id;
  });
}
export const deleteTag = id => db.prepare('DELETE FROM tags WHERE id = ?').run(id);
