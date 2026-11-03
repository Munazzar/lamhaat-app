// Library keys: AES-256 encryption key + HMAC key for photo ids, created on first use.
// Kept in C:\Users\<you>\Lamhaat\keys.json, next to the library and outside every repo. Not under
// AppData: Windows can redirect AppData for sandboxed programs, so two programs could end up with
// different keys and the same photo would get two ids. A copy found in the old AppData place is
// carried over. This file IS the recovery key for encrypted albums: back it up.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = process.env.LAMHAAT_DATA || path.join(os.homedir(), 'Lamhaat');
export const keyFile = path.join(dir, 'keys.json');
const oldFile = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'lamha', 'keys.json');

export function loadKeys() {
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(oldFile)) fs.copyFileSync(oldFile, keyFile);
    else {
      const k = { enc: crypto.randomBytes(32).toString('base64'), hmac: crypto.randomBytes(32).toString('base64') };
      fs.writeFileSync(keyFile, JSON.stringify(k, null, 1), { mode: 0o600, flag: 'wx' });
      console.log('created new library keys at', keyFile, '— back this file up; lose it and encrypted albums are unreadable');
    }
  }
  const k = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  return { enc: Buffer.from(k.enc, 'base64'), hmac: Buffer.from(k.hmac, 'base64') };
}

// ---------- the recovery code: the two keys, written so a person can keep them on paper ----------
// 64 key bytes and a 2-byte check, in groups of four letters and digits (no 0/O or 1/I to mix up)
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function recoveryCode(keys = loadKeys()) {
  const raw = Buffer.concat([keys.enc, keys.hmac]);
  const all = Buffer.concat([raw, crypto.createHash('sha256').update(raw).digest().subarray(0, 2)]);
  let bits = '', out = '';
  for (const b of all) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += ABC[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out.match(/.{1,4}/g).join('-');
}
export function keysFromCode(code) {
  const clean = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  let bits = '';
  for (const c of clean) { const v = ABC.indexOf(c); if (v < 0) throw new Error('That recovery code has a letter that can’t be in one.'); bits += v.toString(2).padStart(5, '0'); }
  const bytes = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  if (bytes.length < 66) throw new Error('That recovery code is too short.');
  const raw = bytes.subarray(0, 64), check = bytes.subarray(64, 66);
  if (!crypto.createHash('sha256').update(raw).digest().subarray(0, 2).equals(check)) throw new Error('That recovery code doesn’t check out. Look for a mistyped letter.');
  return { enc: raw.subarray(0, 32), hmac: raw.subarray(32) };
}
// put the keys from a recovery code in place; the keys there now are kept beside them, never thrown away
export function restoreKeys(code) {
  const k = keysFromCode(code);
  if (fs.existsSync(keyFile)) fs.copyFileSync(keyFile, `${keyFile}.before-restore-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, JSON.stringify({ enc: k.enc.toString('base64'), hmac: k.hmac.toString('base64') }, null, 1), { mode: 0o600 });
  return k;
}
