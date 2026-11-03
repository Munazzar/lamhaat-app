// Grouping a shoot (spec section 4): exact duplicates, near duplicates and bursts, each with a suggested
// best photo and the reason. Pure JS (no Node APIs), so the Android app can reuse it.
// Input photos: { id, name, rel (path inside the shoot), taken (ISO or null), sha256, rawsha, dhash,
//                 tiny (32x32 Uint8Array), sharpness, flags: [...] }

export const GROUP_DEFAULTS = {
  burstGap: 1.5,        // seconds between frames of a held shutter
  burstSimilar: 0.8,    // and they must look alike (thumbnail correlation)...
  burstHash: 22,        // ...or have close fingerprints (bits differing out of 64)
  nearHash: 6,          // near duplicate: fingerprints differ in at most 6 bits...
  nearSimilar: 0.95,    // ...and the thumbnails agree closely
};

export function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < 16; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) { x &= x - 1; n++; }
  }
  return n;
}

export function correlation(a, b) {
  let sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / a.length, mb = sb / b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : (aa === bb ? 1 : 0); // two flat frames (e.g. black) count as alike
}

export function groupShoot(photos, opts = GROUP_DEFAULTS) {
  const usable = photos.filter(p => p.dhash && p.tiny);
  const parent = new Map(usable.map(p => [p.id, p.id]));
  const find = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
  const kinds = new Map(); // root -> set of link kinds
  const link = (a, b, kind) => {
    const ra = find(a.id), rb = find(b.id);
    const k = new Set([...(kinds.get(ra) || []), ...(kinds.get(rb) || []), kind]);
    parent.set(ra, rb); kinds.delete(ra); kinds.set(rb, k);
  };

  // exact: same file, or the same picture decoded (re-saved with different metadata). A second, exact-only
  // union decides the label, so copies taken a second apart are still called copies, not a burst.
  const same = new Map(usable.map(p => [p.id, p.id]));
  const sameRoot = id => { while (same.get(id) !== id) id = same.get(id); return id; };
  const byHash = new Map();
  for (const p of usable) for (const key of [p.sha256, p.rawsha && `raw:${p.rawsha}`].filter(Boolean)) {
    if (byHash.has(key)) { const q = byHash.get(key); link(q, p, 'exact'); same.set(sameRoot(p.id), sameRoot(q.id)); }
    else byHash.set(key, p);
  }
  // bursts: consecutive frames close in time that look alike
  const timed = usable.filter(p => p.taken).map(p => ({ p, t: Date.parse(p.taken) })).sort((a, b) => a.t - b.t || a.p.name.localeCompare(b.p.name));
  for (let i = 1; i < timed.length; i++) {
    const a = timed[i - 1], b = timed[i];
    if ((b.t - a.t) / 1000 > opts.burstGap) continue;
    if (hamming(a.p.dhash, b.p.dhash) <= opts.burstHash || correlation(a.p.tiny, b.p.tiny) >= opts.burstSimilar) link(a.p, b.p, 'burst');
  }
  // near duplicates anywhere in the shoot
  for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) {
    const a = usable[i], b = usable[j];
    if (find(a.id) === find(b.id)) continue;
    if (hamming(a.dhash, b.dhash) <= opts.nearHash && correlation(a.tiny, b.tiny) >= opts.nearSimilar) link(a, b, 'near');
  }

  const members = new Map();
  for (const p of usable) { const r = find(p.id); if (!members.has(r)) members.set(r, []); members.get(r).push(p); }
  const groups = [];
  for (const [root, list] of members) {
    if (list.length < 2) continue;
    const k = kinds.get(root) || new Set();
    const allSame = list.every(p => sameRoot(p.id) === sameRoot(list[0].id));
    const kind = allSame ? 'exact' : k.has('burst') ? 'burst' : 'near';
    list.sort((a, b) => (a.taken || '').localeCompare(b.taken || '') || a.name.localeCompare(b.name));
    groups.push({ id: `g${list[0].id}`, kind, ids: list.map(p => p.id), ...pick(list, kind) });
  }
  return groups;
}

// The suggestion: identical copies keep the first; otherwise the sharpest frame without exposure problems.
function pick(list, kind) {
  if (kind === 'exact') {
    // keep the copy nearest the top of the shoot (an original, not one in a "share" or export subfolder)
    const depth = p => (p.rel || p.name).split(/[\/]/).length;
    const [keep, ...rest] = [...list].sort((a, b) => depth(a) - depth(b) || (a.rel || a.name).localeCompare(b.rel || b.name));
    return { pick: keep.id, reason: `The same photo saved ${list.length === 2 ? 'twice' : `${list.length} times`}; keeping ${keep.rel || keep.name}, ${rest.length === 1 ? 'the copy' : 'copies'} in ${rest.map(p => p.rel || p.name).join(', ')} ${rest.length === 1 ? 'is' : 'are'} extra` };
  }
  const clean = list.filter(p => !p.flags?.some(f => ['highlights', 'shadows', 'blurry', 'motion', 'subject', 'eyes', 'accident'].includes(f))); // closed eyes rank a frame down, never out
  const pool = (clean.length ? clean : list).filter(p => p.sharpness != null);
  if (!pool.length) return { pick: list[0].id, reason: 'Not checked yet; showing the first' };
  // where the AI found the subject in every frame, the frame with the sharpest subject wins
  const sh = pool.every(p => p.subjectSharp != null) ? p => p.subjectSharp : p => p.sharpness;
  const ranked = [...pool].sort((a, b) => sh(b) - sh(a));
  const [best, next] = ranked;
  const margin = next ? sh(best) / Math.max(1, sh(next)) : Infinity;
  const of = `of ${list.length}`;
  let reason = margin >= 1.3 ? `Clearly the sharpest ${of}` : next ? `Sharpest ${of}, by a small margin` : `The only one ${of} in focus`;
  const bad = list.length - clean.length;
  if (clean.length && bad) reason += `; ${bad === 1 ? '1 other has' : `${bad} others have`} blur or exposure problems`;
  return { pick: best.id, reason };
}
