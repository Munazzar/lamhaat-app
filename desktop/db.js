// The desktop app's library: one SQLite file plus a folder of preview JPEGs, in C:\Users\<you>\Lamhaat.
// Not under AppData on purpose: Windows can redirect AppData for sandboxed programs, which split the
// library into two copies once already. Originals are never touched; everything here can be rebuilt by
// importing again, and the last few versions of the library are kept in backups\.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const dataDir = process.env.LAMHAAT_DATA || path.join(os.homedir(), 'Lamhaat');
export const previewDir = path.join(dataDir, 'previews');
const backupDir = path.join(dataDir, 'backups');
fs.mkdirSync(previewDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });
const file = path.join(dataDir, 'library.db');

// a dated copy before every start, keeping the newest 5
if (fs.existsSync(file) && fs.statSync(file).size > 0) {
  fs.copyFileSync(file, path.join(backupDir, `library-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
  const old = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort().slice(0, -5);
  for (const f of old) fs.rmSync(path.join(backupDir, f), { force: true });
}

export const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = DELETE;  -- every commit lands in library.db itself; no side files to lose
  PRAGMA synchronous = FULL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS folders (
    path        TEXT PRIMARY KEY,
    imported_at TEXT
  );
  CREATE TABLE IF NOT EXISTS photos (
    id        INTEGER PRIMARY KEY,
    folder    TEXT NOT NULL REFERENCES folders(path) ON DELETE CASCADE,
    path      TEXT NOT NULL UNIQUE,
    name      TEXT NOT NULL,
    size      INTEGER NOT NULL,
    mtime     REAL NOT NULL,
    sha256    TEXT NOT NULL,
    w         INTEGER, h INTEGER,
    taken     TEXT,
    camera    TEXT, lens TEXT, iso INTEGER, shutter TEXT, f REAL,
    decision  TEXT NOT NULL DEFAULT 'undecided' CHECK (decision IN ('undecided', 'keep', 'reject'))
  );
  CREATE INDEX IF NOT EXISTS photos_folder ON photos(folder, taken, name);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS albums (folder TEXT PRIMARY KEY REFERENCES folders(path) ON DELETE CASCADE, data TEXT NOT NULL);
`);
const ok = db.prepare('PRAGMA quick_check').get();
if (Object.values(ok)[0] !== 'ok') throw new Error(`The library file is damaged (${Object.values(ok)[0]}). A copy is in ${backupDir}.`);
process.on('exit', () => { try { db.close(); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0)); // so 'exit' runs and the file is closed

export const setting = (key, fallback) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
export const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

export const previewPath = sha => path.join(previewDir, `${sha}.jpg`);
