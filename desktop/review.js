// The suggested decision for every photo: what "Accept suggestions" applies (spec section 4, step 6).
// Only a suggestion: nothing is rejected until the user accepts it or decides themselves.
// Pure JS (no Node APIs), so the Android app can reuse it.
// In a group the pick is kept and the rest rejected; alone, a blurry or shaken photo is rejected.
// Exposure flags never reject on their own: a blown sky or a silhouette is often on purpose.
export function suggest(photos, groups) {
  const byId = new Map(photos.map(p => [p.id, p]));
  const name = id => byId.get(id)?.rel || byId.get(id)?.name;
  const out = new Map();
  for (const g of groups) for (const id of g.ids) {
    out.set(id, id === g.pick ? { suggest: 'keep', why: g.reason }
      : { suggest: 'reject', why: g.kind === 'exact' ? `Extra copy of ${name(g.pick)}` : `${g.kind === 'burst' ? 'Burst' : 'Near duplicate'}; ${name(g.pick)} is the better frame` });
  }
  for (const p of photos) {
    if (out.has(p.id)) continue;
    const blur = p.flags?.find(f => f === 'motion' || f === 'blurry' || f === 'subject' || f === 'accident');
    out.set(p.id, blur ? { suggest: 'reject', why: { motion: 'Motion blur', blurry: 'Blurry', subject: 'The subject is out of focus', accident: 'Looks taken by accident' }[blur] }
      : { suggest: 'keep', why: p.flags?.length ? 'Flagged for a look, but often on purpose: kept' : p.sharpness == null ? 'Not checked yet' : 'No problems found' });
  }
  return out;
}
