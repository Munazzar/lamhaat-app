// A photo with its edits, from the original file, for edited thumbnails and for publishing.
// The order matches the window's drawing exactly: flips, quarter turn + straighten, crop, then
// light and colour on the smaller result (quick, and sharpening suits the final size).
import sharp from 'sharp';
import { tidy, frame, applyPixels } from './edit.js';
import { readable } from './raw.js';

// returns a sharp pipeline, ready for .jpeg() / .avif(), at most `edge` pixels on the long side
export async function edited(file, edits, edge) {
  const e = tidy(edits);
  const base = sharp(readable(file), { failOn: 'none' }).rotate(); // (a RAW file: its developed picture) // the camera's own orientation first
  if (!e) return base.resize(edge, edge, { fit: 'inside', withoutEnlargement: true });
  let img = base;
  if (e.flipH) img = img.flop();
  if (e.flipV) img = img.flip();
  const one = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = one.info;
  const f = frame(e, w, h);
  const turned = sharp(one.data, { raw: { width: w, height: h, channels } }).rotate(e.turn + e.straighten, { background: '#000' });
  const big = await turned.raw().toBuffer({ resolveWithObject: true }); // the bounding box of the turned picture
  const W2 = big.info.width, H2 = big.info.height;
  const left = Math.max(0, Math.round((W2 - f.fw) / 2 + f.crop.x)), top = Math.max(0, Math.round((H2 - f.fh) / 2 + f.crop.y));
  const cw = Math.max(1, Math.min(W2 - left, Math.round(f.crop.w))), chh = Math.max(1, Math.min(H2 - top, Math.round(f.crop.h)));
  const cut = await sharp(big.data, { raw: { width: W2, height: H2, channels: big.info.channels } })
    .extract({ left, top, width: cw, height: chh })
    .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  const px = new Uint8ClampedArray(cut.data.buffer, cut.data.byteOffset, cut.data.length);
  applyPixels(px, cut.info.width, cut.info.height, cut.info.channels, e);
  return sharp(cut.data, { raw: { width: cut.info.width, height: cut.info.height, channels: cut.info.channels } });
}
