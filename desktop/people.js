// The people you share private albums with: their Google (Gmail) address, a name, and groups such
// as family or friends. A private album lists the groups that may see it. This list lives here;
// Firebase gets a copy whenever it changes (firebase.js).
import { db } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS people (
  email  TEXT PRIMARY KEY,
  name   TEXT,
  groups TEXT NOT NULL DEFAULT '[]',
  added  TEXT NOT NULL
)`);

export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const tidyGroups = gs => [...new Set((Array.isArray(gs) ? gs : []).map(g => String(g).trim().toLowerCase().slice(0, 40)).filter(g => g && g !== 'owner' && g !== 'everyone'))].slice(0, 20); // both are built in

export const people = () => db.prepare('SELECT email, name, groups, added FROM people ORDER BY coalesce(name, email)').all().map(p => ({ ...p, groups: JSON.parse(p.groups) }));
// every group anyone is in, plus the two everyone starts with
export const groupList = () => [...new Set(['family', 'friends', ...people().flatMap(p => p.groups)])];

export function savePerson({ email, name, groups }) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) throw new Error('That isn’t an email address.');
  const g = tidyGroups(groups);
  if (!g.length) throw new Error('Put them in at least one group, or they can’t see anything.');
  db.prepare(`INSERT INTO people (email, name, groups, added) VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET name = excluded.name, groups = excluded.groups`).run(email, String(name || '').trim().slice(0, 80) || null, JSON.stringify(g), new Date().toISOString());
  return email;
}
export const removePerson = email => db.prepare('DELETE FROM people WHERE email = ?').run(String(email || '').toLowerCase());
// what the access check needs: email -> groups
export const allowlist = () => Object.fromEntries(people().map(p => [p.email, p.groups]));
