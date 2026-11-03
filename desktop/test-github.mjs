// Run: node desktop/test-github.mjs
// "Sign in with GitHub" without a network: the link GitHub gets, and every way the return can go wrong.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.LAMHAAT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lamhaat-gh-'));
process.env.LAMHAAT_NO_BROWSER = '1';
const gh = await import('./github.js');

assert.throws(() => gh.webStart('github.com', 'http://127.0.0.1:5190/github/callback'), /isn’t set up/, 'no app registered yet');
gh.setApp('github.com', 'Ov23liTestTestTest00', 'secretsecretsecretsecret0000');
assert.deepEqual(gh.appReady('github.com'), { code: true, browser: true });
const url = new URL(gh.webStart('github.com', 'http://127.0.0.1:5190/github/callback'));
assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
const q = url.searchParams;
assert.equal(q.get('client_id'), 'Ov23liTestTestTest00');
assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:5190/github/callback');
assert.equal(q.get('scope'), 'repo');
assert.equal(q.get('code_challenge_method'), 'S256');
assert.ok(q.get('state').length >= 30 && q.get('code_challenge').length >= 40);
assert.ok(!url.href.includes('secret'), 'the secret never goes in the browser link');

const back = p => gh.webFinish(new URLSearchParams(p));
await assert.rejects(back({ state: 'made-up', code: 'x' }), e => e.kind === 'expired', 'unknown state refused');
await assert.rejects(back({ state: q.get('state'), error: 'access_denied' }), e => e.kind === 'declined', 'declined on GitHub');
await assert.rejects(back({ state: q.get('state'), code: 'x' }), e => e.kind === 'expired', 'a state works once only');
// Enterprise: its own address and its own app
assert.equal(new URL((gh.setApp('ghe.example.com', 'Iv1.abcdefabcdef', 'secretsecretsecretsecret0000'), gh.webStart('ghe.example.com', 'http://127.0.0.1:5190/github/callback'))).origin, 'https://ghe.example.com');
assert.deepEqual(gh.urls('ghe.example.com'), { api: 'https://ghe.example.com/api/v3', web: 'https://ghe.example.com' });
assert.equal(gh.cleanHost(' https://GHE.Example.com/login '), 'ghe.example.com');
// an expiring sign-in is renewed quietly when close to running out, and kept as is otherwise
const { fakeGitHub } = await import('./fake-github.mjs');
const fake = await fakeGitHub(path.join(process.env.LAMHAAT_DATA, 'gh'));
gh.setApp(fake.host, 'Ov23liTestTestTest00', 'secretsecretsecretsecret0000');
await gh.save({ token: 'old', host: fake.host, method: 'browser', refresh: 'renew-me', expires: Date.now() + 60e3, refreshExpires: Date.now() + 864e5 });
assert.equal((await gh.fresh()).token, 'renewed-1', 'renewed: one minute left');
assert.ok(gh.current().expires > Date.now() + 7 * 3600e3, 'good for 8 hours again');
assert.equal((await gh.fresh()).token, 'renewed-1', 'not renewed again while it has time left');
await gh.save({ ...gh.current(), expires: Date.now() - 1, refreshExpires: Date.now() - 1 });
await assert.rejects(gh.fresh(), e => e.kind === 'signin', 'six months unused: sign in again');
await gh.save({ token: 'plain', host: fake.host, method: 'token' });
assert.equal((await gh.fresh()).token, 'plain', 'a token that never expires is left alone');
// signing out: a pasted token is only forgotten here; a sign-in through your GitHub app is cancelled on GitHub too
assert.deepEqual(await gh.signOut(), { revoked: false }); assert.equal(gh.current(), null);
await gh.save({ token: 'via-app', host: fake.host, method: 'browser' });
assert.deepEqual(await gh.signOut(), { revoked: true });
assert.deepEqual(fake.counts.revoked, ['via-app']); assert.equal(gh.current(), null);
await fake.close();
(await import('./db.js')).db.close();
fs.rmSync(process.env.LAMHAAT_DATA, { recursive: true, force: true });
console.log('ok');
