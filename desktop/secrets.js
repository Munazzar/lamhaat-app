// Secrets (the GitHub sign-in) are kept encrypted with Windows' own data protection (DPAPI): only
// your Windows account on this PC can read them back. Never in the library file, never in logs.
// ponytail: DPAPI through PowerShell (built into Windows), no native module; Credential Manager if
// another program ever needs to read them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './db.js';

const dir = path.join(dataDir, 'secrets');
const ps = (script, input) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Add-Type -AssemblyName System.Security; $s = [Console]::In.ReadToEnd(); ${script}`], { input, windowsHide: true }).toString().trim();

export function saveSecret(name, value) {
  fs.mkdirSync(dir, { recursive: true });
  const sealed = ps("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s), $null, 'CurrentUser'))", value);
  fs.writeFileSync(path.join(dir, `${name}.dpapi`), sealed);
}
export function loadSecret(name) {
  const file = path.join(dir, `${name}.dpapi`);
  if (!fs.existsSync(file)) return null;
  try { return ps("[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s), $null, 'CurrentUser'))", fs.readFileSync(file, 'utf8')); }
  catch { return null; } // made under another Windows account, or damaged: sign in again
}
export const removeSecret = name => fs.rmSync(path.join(dir, `${name}.dpapi`), { force: true });
