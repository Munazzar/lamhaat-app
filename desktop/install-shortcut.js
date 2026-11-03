// Puts a Lamhaat shortcut on the Desktop and in the Start menu, with the shutter icon.
// usage: node desktop/install-shortcut.js
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { dataDir } from './db.js';

// A proper Windows icon: classic bitmaps for the small sizes (what the Desktop and Start menu
// actually draw), plus a compressed 256px image for large views.
const svg = path.join(import.meta.dirname, 'ui', 'logo.svg');
const sizes = [16, 24, 32, 48, 64, 256];
const images = [];
for (const s of sizes) {
  const { data } = await sharp(svg, { density: 72 * 256 / 64 }).resize(s, s).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (s === 256) { images.push(await sharp(data, { raw: { width: s, height: s, channels: 4 } }).png().toBuffer()); continue; }
  // BITMAPINFOHEADER + bottom-up BGRA pixels + 1-bit AND mask (all zero: alpha decides)
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0); head.writeInt32LE(s, 4); head.writeInt32LE(s * 2, 8);
  head.writeUInt16LE(1, 12); head.writeUInt16LE(32, 14); head.writeUInt32LE(s * s * 4, 20);
  const px = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const i = (y * s + x) * 4, o = ((s - 1 - y) * s + x) * 4;
    px[o] = data[i + 2]; px[o + 1] = data[i + 1]; px[o + 2] = data[i]; px[o + 3] = data[i + 3];
  }
  const mask = Buffer.alloc(Math.ceil(s / 32) * 4 * s);
  images.push(Buffer.concat([head, px, mask]));
}
const dir = Buffer.alloc(6 + 16 * sizes.length);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  dir.writeUInt8(s === 256 ? 0 : s, e); dir.writeUInt8(s === 256 ? 0 : s, e + 1);
  dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(images[i].length, e + 8); dir.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
const ico = path.join(dataDir, 'lamhaat.ico');
fs.writeFileSync(ico, Buffer.concat([dir, ...images]));

const vbs = path.join(import.meta.dirname, 'Lamhaat.vbs');
const ps = `
$sh = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $lnk = Join-Path $dir 'Lamhaat.lnk'
  if (Test-Path $lnk) { Remove-Item $lnk -Force }   # a fresh shortcut, so Windows doesn't reuse a cached blank icon
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = "$env:WINDIR\\System32\\wscript.exe"
  $s.Arguments = '"${vbs}"'
  $s.WorkingDirectory = '${path.dirname(import.meta.dirname)}'
  $s.IconLocation = '${ico},0'
  $s.Description = 'Lamhaat: cull, organise and publish your photos'
  $s.Save()
  Write-Output $lnk
}
ie4uinit.exe -show   # ask Windows to refresh its icon cache`;
console.log(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim());
