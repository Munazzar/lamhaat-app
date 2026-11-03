// Run: node desktop/test-album.mjs
// Albums on a made-up shoot over three days.
import assert from 'node:assert';
import { inAlbum, defaultAlbum, assign, clean, split, merge, titleCase } from './album.js';

// local times, so "a day" means the photographer's day whatever the computer's time zone
const at = (d, hh, mm = 0) => new Date(2026, 8, d, hh, mm).toISOString();
const P = (id, taken, decision = 'undecided') => ({ id, name: `IMG_${id}.jpg`, taken, decision });
const photos = [
  P(1, at(4, 9)), P(2, at(4, 23, 50)), P(3, at(5, 0, 10)), P(4, at(5, 12), 'reject'), P(5, at(5, 18), 'keep'),
  P(6, at(7, 8)), P(7, null), P(8, at(4, 8)),
];
const list = inAlbum(photos);
assert.deepEqual(list.map(p => p.id), [8, 1, 2, 3, 5, 6, 7], 'rejected left out, by time, undated last');

const album = defaultAlbum('lake weekend 2026', photos);
assert.equal(album.title, 'Lake Weekend 2026');
assert.equal(album.chapters.length, 3, 'one chapter per day');
assert.equal(album.chapters[0].start, null, 'the first chapter starts at the beginning');
assert.match(album.chapters[1].title, /^Saturday,? 5 September$/);
const parts = assign(album, list);
assert.deepEqual(parts.map(c => c.photos.map(p => p.id)), [[8, 1, 2], [3, 5], [6, 7]], 'midnight splits days; undated in the last');

// one day only: a single chapter
assert.equal(defaultAlbum('x', [P(1, at(4, 9)), P(2, at(4, 20))]).chapters.length, 1);
assert.equal(defaultAlbum('x', []).chapters.length, 1);

// split and merge
const s = split(album, list.find(p => p.id === 1));
assert.deepEqual(assign(s, list).map(c => c.photos.map(p => p.id)), [[8], [1, 2], [3, 5], [6, 7]]);
assert.equal(split(s, list.find(p => p.id === 1)), s, 'splitting twice at one photo does nothing');
assert.equal(split(s, list.find(p => p.id === 7)), s, 'an undated photo cannot start a chapter');
const m = merge(s, 2);
assert.deepEqual(assign(m, list).map(c => c.photos.map(p => p.id)), [[8], [1, 2, 3, 5], [6, 7]]);
assert.equal(merge(s, 0), s, 'the first chapter has nothing before it');

// clean: stale ids dropped, cover falls back, chapters put in order, junk ignored
const c = clean({ title: 'T', cover: 99, highlights: [5, 99, 5, 3], chapters: [{ start: at(7, 0), title: 'B' }, { start: null, title: 'A' }, { start: at(7, 0), title: 'dup' }, 'junk'] }, list);
assert.deepEqual(c.highlights, [5, 3]);
assert.equal(c.cover, 5, 'missing cover: the first highlight');
assert.deepEqual(c.chapters.map(x => x.title), ['A', 'B']);
assert.equal(clean({ chapters: [{ start: at(5, 0), title: 'B' }] }, list).chapters[0].start, null, 'always a first chapter');
assert.equal(clean(null, list).cover, 8, 'no album yet: the first photo is the cover');
assert.equal(titleCase('spring 2025 hills and city'), 'Spring 2025 Hills And City');
console.log('ok');

// collected over years: by month, and by year when months are too many
const years = Array.from({ length: 30 }, (_, i) => P(100 + i, new Date(2012 + Math.floor(i / 3), (i * 5) % 12, 3).toISOString()));
const byYear = defaultAlbum('x', years).chapters;
assert.equal(byYear.length, 10, 'ten years, ten chapters');
assert.equal(byYear[1].title, '2013');
const months = Array.from({ length: 8 }, (_, i) => P(200 + i, new Date(2026, i, 10).toISOString()));
assert.deepEqual(defaultAlbum('x', months).chapters.map(c => c.title).slice(0, 2), ['January 2026', 'February 2026']);
console.log('ok, long spans');

// grouped by people, tags or camera; sorted within chapters; custom chapter names kept
const tags = new Map([[1, { name: 'Sam', kind: 'person' }], [2, { name: 'Alex', kind: 'person' }], [3, { name: 'beach', kind: 'tag' }]]);
const ppl = [P(1, at(4, 9)), P(2, at(4, 10)), P(3, at(4, 11)), P(4, at(4, 12)), P(5, at(4, 13))].map((p, i) => ({ ...p, tags: [[1], [1, 2], [2], [3], []][i], camera: i < 2 ? 'X100VI' : 'Pixel', title: ['b', '', 'a', '', ''][i] }));
const byPerson = assign(clean({ groupBy: 'person', names: { '': { title: 'The rest' } } }, ppl), ppl, tags);
assert.deepEqual(byPerson.map(c => [c.title, c.photos.map(p => p.id)]), [['Alex', [2, 3]], ['Sam', [1]], ['The rest', [4, 5]]], 'most photographed first; a photo in its first fitting chapter');
const byCam = assign(clean({ groupBy: 'camera', sort: 'newest' }, ppl), ppl, tags);
assert.deepEqual(byCam.map(c => [c.title, c.photos.map(p => p.id)]), [['Pixel', [5, 4, 3]], ['X100VI', [2, 1]]]);
const byTitle = assign(clean({ groupBy: 'tag', sort: 'title', names: { 3: { title: 'Sea', sub: 'salt' } } }, ppl), ppl, tags);
assert.deepEqual(byTitle.map(c => [c.title, c.sub, c.photos.map(p => p.id)]), [['Sea', 'salt', [4]], ['Other photos', '', [3, 1, 2, 5]]]);
assert.equal(clean({ groupBy: 'evil', sort: 'x' }, ppl).groupBy, 'date');
console.log('ok, grouping');

// chapters by place, time of day and scene
{
  const { assign: as2, placesOf } = await import('./album.js');
  const at = (id, taken, lat, lon, aiTags = []) => ({ id, name: `P${id}.jpg`, taken, lat, lon, aiTags, decision: 'keep' });
  const ps = [at(1, '2026-05-01T08:00:00Z', 46.5, -86.3, ['beach']), at(2, '2026-05-01T09:00:00Z', 46.505, -86.301, ['beach', 'lake']),
    at(3, '2026-05-01T15:00:00Z', 46.7, -86.0, ['forest']), at(4, '2026-05-01T22:00:00Z', null, null, ['lake'])];
  assert.equal(new Set(placesOf(ps).values()).size, 2, 'two places 25 km apart; the 0.6 km pair is one');
  const byPlace = as2({ groupBy: 'place', chapters: [] }, ps);
  assert.deepEqual(byPlace.map(c => c.title), ['Place 1', 'Place 2', 'No location recorded']);
  assert.deepEqual(byPlace.map(c => c.photos.map(p => p.id)), [[1, 2], [3], [4]]);
  assert.deepEqual(as2({ groupBy: 'scene', chapters: [] }, ps).map(c => c.title), ['Beach', 'Lake', 'Forest']);
  const parts = as2({ groupBy: 'daypart', chapters: [] }, ps).map(c => c.title);
  assert.equal(parts.at(-1) === 'Night' || parts.includes('Night'), true);
  console.log('ok: place, time of day, scene');
}

// your own chapters: the tags you choose bring a photo in; the first chapter that fits wins, the rest go last
{
  const { assign: as3, clean: cl } = await import('./album.js');
  const tagMap = new Map([[1, { name: 'chicago', kind: 'tag' }], [2, { name: 'lake', kind: 'tag' }], [3, { name: 'autumn', kind: 'tag' }]]);
  const ph = (id, tg) => ({ id, name: `P${id}.jpg`, taken: `2026-01-0${id}T10:00:00Z`, tags: tg, decision: 'keep' });
  const ps = [ph(1, [1]), ph(2, [2, 3]), ph(3, [3]), ph(4, [])];
  const album = cl({ groupBy: 'rules', rules: [{ title: 'The City', sub: 'winter', tags: ['Chicago'] }, { title: 'Water', tags: ['lake'] }, { title: 'The Turning', tags: ['autumn'] }] }, ps);
  const parts = as3(album, ps, tagMap);
  assert.deepEqual(parts.map(c => c.title), ['The City', 'Water', 'The Turning', 'Other photos']);
  assert.deepEqual(parts.map(c => c.photos.map(p => p.id)), [[1], [2], [3], [4]], 'first chapter that fits wins (2 has lake and autumn)');
  console.log('ok: your own chapters');
}

// scene words that are one word in two forms make one chapter
{
  const { assign: as4 } = await import('./album.js');
  const ph = (id, t) => ({ id, name: `S${id}.jpg`, taken: `2026-02-0${id}T10:00:00Z`, aiTags: t, decision: 'keep' });
  const ps = [ph(1, ['sleeping', 'baby']), ph(2, ['sleep']), ph(3, ['trees']), ph(4, ['tree']), ph(5, ['sleeping']), ph(6, ['car']), ph(7, ['car'])];
  const titles = as4({ groupBy: 'scene', chapters: [] }, ps).map(c => c.title + ' ' + c.photos.length);
  assert.deepEqual(titles, ['Sleep 3', 'Car 2', 'Tree 2'], titles.join(', '));
  console.log('ok: scene words');
}
