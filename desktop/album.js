// An album: one per shoot. Every photo you haven't rejected, in the order taken, split into
// chapters by time, with a title, a cover and a few highlights. Pure JS (no Node APIs), so the
// Android app and the gallery can reuse it.
// album = { title, description, cover: photoId|null, highlights: [photoId], groupBy, sort,
//           chapters: [{ start: ISO|null, title, sub }],   (groupBy 'date')
//           names: { [key]: { title, sub } } }               (every other groupBy)
// By date, a chapter holds the photos taken from its start up to the next chapter's start; the first
// starts at the beginning, and photos with no date go in the last. By person, tag or camera, there is
// a chapter for each one (the most photographed first); a photo goes in the first that fits it, and
// photos that fit none go in a last chapter. By place, photos taken within 2 km of each other share a
// chapter, in the order first visited; by time of day, morning to night; by scene, the AI's words for
// what is in the photo. Within chapters, photos follow `sort`.
export const GROUPS = { rules: 'Tags you choose', date: 'Date and time', place: 'Place (GPS)', daypart: 'Time of day', person: 'People', tag: 'Tags', scene: 'Scene (AI)', camera: 'Camera' };
export const SORTS = { taken: 'Oldest first', newest: 'Newest first', title: 'Title', name: 'File name' };

export const inAlbum = photos => photos.filter(p => p.decision !== 'reject')
  .sort((a, b) => (a.taken ? 0 : 1) - (b.taken ? 0 : 1) || (a.taken || '').localeCompare(b.taken || '') || a.name.localeCompare(b.name));

// a chapter per day for a trip; per month, or per year, for photos collected over a long time
const UNITS = [
  { key: d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`, name: d => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) },
  { key: d => `${d.getFullYear()}-${d.getMonth()}`, name: d => d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) },
  { key: d => `${d.getFullYear()}`, name: d => String(d.getFullYear()) },
];
const MAX_CHAPTERS = 12;
export const titleCase = s => s.replace(/(^|[\s-])(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());

// first suggestion: the finest of day (within a month) / month / year that gives at most 12 chapters
export function defaultChapters(photos) {
  const timed = photos.filter(p => p.taken);
  let chapters = [];
  const days = timed.length ? (Date.parse(timed.at(-1).taken) - Date.parse(timed[0].taken)) / 864e5 : 0;
  for (const unit of UNITS) {
    if (unit === UNITS[0] && days > 31) continue; // day names without a year only read well within one trip
    chapters = [];
    let last = null;
    for (const p of timed) {
      const k = unit.key(new Date(p.taken));
      if (k !== last) chapters.push({ start: chapters.length ? p.taken : null, title: unit.name(new Date(p.taken)), sub: '' });
      last = k;
    }
    if (chapters.length <= MAX_CHAPTERS) break;
  }
  return chapters.length < 2 ? [{ start: null, title: '', sub: '' }] : chapters;
}

export function defaultAlbum(folderName, photos) {
  return { title: titleCase(folderName), cover: null, highlights: [], chapters: defaultChapters(inAlbum(photos)) };
}

const ORDER = {
  taken: (a, b) => (a.taken ? 0 : 1) - (b.taken ? 0 : 1) || (a.taken || '').localeCompare(b.taken || '') || a.name.localeCompare(b.name),
  newest: (a, b) => (b.taken || '').localeCompare(a.taken || '') || a.name.localeCompare(b.name),
  title: (a, b) => (a.title ? 0 : 1) - (b.title ? 0 : 1) || (a.title || '').localeCompare(b.title || '') || ORDER.taken(a, b),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
};
// what a photo can be grouped by: its people, its tags, the AI's scene words, its camera, its time of
// day or its place. `tags` maps tag id -> { name, kind }; `places` maps photo id -> place key
const DAYPARTS = ['Morning', 'Afternoon', 'Evening', 'Night'];
const daypart = iso => { const h = new Date(iso).getHours(); return h >= 5 && h < 12 ? 'Morning' : h >= 12 && h < 17 ? 'Afternoon' : h >= 17 && h < 21 ? 'Evening' : 'Night'; };
const keysOf = (p, by, tags, places) => by === 'camera' ? (p.camera ? [p.camera] : [])
  : by === 'scene' ? [...new Set((p.aiTags || []).slice(0, 4).map(t => places?.canon?.(t) ?? t))]
  : by === 'daypart' ? (p.taken ? [daypart(p.taken)] : [])
  : by === 'place' ? (places.has(p.id) ? [places.get(p.id)] : [])
  : (p.tags || []).filter(id => tags.get(id)?.kind === by).map(String);
// places: photos within 2 km of a place's first photo belong to it; a place is named by where it starts
const km = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371; };
// scene words: "sleeping" and "sleep", or "trees" and "tree", are one chapter when both are there
function sceneWords(photos) {
  const all = new Set(photos.flatMap(p => p.aiTags || []));
  return { canon: t => t.endsWith('ing') && all.has(t.slice(0, -3)) ? t.slice(0, -3) : t.endsWith('s') && all.has(t.slice(0, -1)) ? t.slice(0, -1) : t };
}
export function placesOf(photos) {
  const centres = [], out = new Map();
  for (const p of photos) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    let c = centres.find(c => km(c, p) < 2);
    if (!c) centres.push(c = { lat: p.lat, lon: p.lon, key: `${p.lat.toFixed(3)},${p.lon.toFixed(3)}` });
    out.set(p.id, c.key);
  }
  return out;
}

// photos (already inAlbum order) -> the chapters with their photos
export function assign(album, photos, tags = new Map()) {
  const by = album.groupBy || 'date';
  let out;
  if (by === 'rules') {
    // your own chapters, each with the tags that bring a photo into it: a photo goes to the first that fits
    // (the way the site always placed them), and the rest to a last chapter
    const names = p => new Set((p.tags || []).map(id => tags.get(id)?.name?.toLowerCase()).filter(Boolean));
    out = [...(album.rules || []).map(c => ({ ...c, photos: [] })), { title: album.rest?.title || 'Other photos', sub: album.rest?.sub || '', tags: [], rest: true, photos: [] }];
    for (const p of photos) { const mine = names(p); (out.find(c => c.tags.length && c.tags.some(t => mine.has(t))) || out.at(-1)).photos.push(p); }
    out = out.filter((c, i) => c.photos.length || i < out.length - 1);
  } else if (by === 'date') {
    out = album.chapters.map(c => ({ ...c, photos: [] }));
    for (const p of photos) {
      let i = out.length - 1;
      if (p.taken) while (i > 0 && out[i].start > p.taken) i--;
      out[i].photos.push(p);
    }
  } else {
    const count = new Map(), first = new Map(), places = by === 'place' ? placesOf(photos) : by === 'scene' ? sceneWords(photos) : null;
    for (const p of photos) for (const k of keysOf(p, by, tags, places)) { count.set(k, (count.get(k) || 0) + 1); if (!first.has(k)) first.set(k, first.size); }
    const placeNo = new Map([...first.keys()].map((k, i) => [k, i + 1]));
    const named = k => by === 'place' ? `Place ${placeNo.get(k)}` : by === 'scene' ? titleCase(k) : by === 'camera' || by === 'daypart' ? k : tags.get(Number(k))?.name || k;
    // places in the order you went there, times of day in the day's order, the rest the most photographed first
    // by scene, a word on more than half the photos (every photo of a baby says "baby") says nothing new
    if (by === 'scene' && [...count.values()].some(n => n <= photos.length / 2)) for (const [k, n] of count) if (n > photos.length / 2) count.delete(k);
    const keys = [...count.keys()].sort(by === 'place' ? (a, b) => first.get(a) - first.get(b) : by === 'daypart' ? (a, b) => DAYPARTS.indexOf(a) - DAYPARTS.indexOf(b)
      : (a, b) => count.get(b) - count.get(a) || named(a).localeCompare(named(b)));
    out = [...keys, null].map(key => ({ key, title: album.names?.[key ?? '']?.title || (key == null ? '' : named(key)), sub: album.names?.[key ?? '']?.sub || '', photos: [] }));
    for (const p of photos) {
      const mine = new Set(keysOf(p, by, tags, places));
      (out.find(c => c.key != null && mine.has(c.key)) || out.at(-1)).photos.push(p);
    }
    if (out.length > 1 && !out.at(-1).title) out.at(-1).title = { person: 'Everyone else', place: 'No location recorded', daypart: 'No time recorded' }[by] || 'Other photos';
    out = out.filter(c => c.photos.length);
  }
  const order = ORDER[album.sort] || ORDER.taken;
  for (const c of out) c.photos.sort(order);
  return out;
}

// make a stored album safe against the photos as they are now (some may be gone or rejected since)
export function clean(album, photos) {
  const ok = new Set(photos.map(p => p.id));
  const seen = new Set();
  const chapters = (Array.isArray(album?.chapters) ? album.chapters : [])
    .filter(c => c && (c.start == null || typeof c.start === 'string'))
    .map(c => ({ start: c.start ?? null, title: String(c.title ?? '').slice(0, 120), sub: String(c.sub ?? '').slice(0, 200) }))
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
    .filter(c => !seen.has(c.start) && seen.add(c.start));
  if (!chapters.length || chapters[0].start != null) chapters.unshift({ start: null, title: '', sub: '' });
  const highlights = [...new Set((album?.highlights || []).filter(id => ok.has(id)))];
  const cover = ok.has(album?.cover) ? album.cover : highlights[0] ?? photos[0]?.id ?? null;
  const names = {};
  for (const [k, v] of Object.entries(album?.names || {}).slice(0, 500)) {
    if (v && typeof v === 'object') names[String(k).slice(0, 120)] = { title: String(v.title ?? '').slice(0, 120), sub: String(v.sub ?? '').slice(0, 200) };
  }
  const rules = (Array.isArray(album?.rules) ? album.rules : []).slice(0, 60).filter(c => c && typeof c === 'object')
    .map(c => ({ title: String(c.title ?? '').slice(0, 120), sub: String(c.sub ?? '').slice(0, 200), tags: [...new Set((Array.isArray(c.tags) ? c.tags : []).map(t => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 30) }));
  return {
    ...(rules.length && { rules }),
    // the last chapter, for every photo no other one takes: its own name
    ...(album?.rest && typeof album.rest === 'object' && { rest: { title: String(album.rest.title ?? '').slice(0, 120), sub: String(album.rest.sub ?? '').slice(0, 200) } }),
    title: String(album?.title ?? '').slice(0, 120), description: String(album?.description ?? '').slice(0, 2000), cover, highlights, chapters,
    groupBy: album?.groupBy in GROUPS ? album.groupBy : 'date', sort: album?.sort in SORTS ? album.sort : 'taken', names,
    // who may see it when private: groups of people (the owner always can)
    ...(Array.isArray(album?.groups) && { groups: [...new Set(album.groups.map(g => String(g).trim().toLowerCase().slice(0, 40)).filter(g => g && g !== 'owner'))].slice(0, 20) }),
    // once published: its opaque id on GitHub, and whether the public site shows it
    ...(/^[a-z0-9]{10}$/.test(album?.id) && { id: album.id }), public: album?.public === true,
    // full-size copies for the large view on the site (on unless turned off)
    full: album?.full !== false,
    // where photos were taken, on the site's map: off unless chosen, and then only to about 1 km
    ...(album?.geo === true && { geo: true }),
    ...(album?.allowSensitive === true && { allowSensitive: true }), // the owner chose to publish photos the AI marked sensitive
  };
}

// a new chapter starting at this photo
export function split(album, photo) {
  if (!photo.taken || album.chapters.some(c => c.start === photo.taken)) return album;
  return { ...album, chapters: [...album.chapters, { start: photo.taken, title: 'New chapter', sub: '' }].sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '')) };
}
// chapter i joins the one before it
export const merge = (album, i) => i > 0 ? { ...album, chapters: album.chapters.filter((_, j) => j !== i) } : album;
