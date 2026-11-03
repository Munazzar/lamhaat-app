// Run: node desktop/test-review.mjs
// Suggested decisions on a small made-up shoot with known answers.
import assert from 'node:assert';
import { suggest } from './review.js';

const P = (id, flags = [], extra = {}) => ({ id, name: `IMG_${id}.jpg`, rel: `IMG_${id}.jpg`, sharpness: 500, flags, ...extra });
const photos = [P(1), P(2, ['blurry']), P(3), P(4, ['highlights']), P(5, ['motion']), P(6), P(7), P(8, [], { sharpness: null }), P(9, ['shadows', 'blurry'])];
const groups = [
  { id: 'g1', kind: 'burst', ids: [1, 2, 3], pick: 3, reason: 'Clearly the sharpest of 3' },
  { id: 'g6', kind: 'exact', ids: [6, 7], pick: 6, reason: 'The same photo saved twice' },
];
const s = suggest(photos, groups);
const d = id => s.get(id).suggest;
assert.equal(d(3), 'keep', 'burst pick kept');
assert.equal(s.get(3).why, 'Clearly the sharpest of 3');
assert.equal(d(1), 'reject', 'other burst frames rejected');
assert.equal(d(2), 'reject');
assert.match(s.get(1).why, /^Burst; IMG_3.jpg is the better frame/);
assert.equal(d(6), 'keep');
assert.equal(d(7), 'reject');
assert.equal(s.get(7).why, 'Extra copy of IMG_6.jpg');
assert.equal(d(4), 'keep', 'exposure alone never rejects');
assert.equal(d(5), 'reject', 'motion blur alone is rejected');
assert.equal(s.get(5).why, 'Motion blur');
assert.equal(d(9), 'reject', 'blur wins over exposure');
assert.equal(s.get(8).why, 'Not checked yet');
assert.equal(s.size, photos.length, 'every photo gets a suggestion');
console.log('ok');
