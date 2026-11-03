// Talking to GitHub: signing in, the REST API, and git with the sign-in attached.
// Ways to sign in, so every kind of account works:
//   1. "Sign in with GitHub": your browser opens GitHub, you approve Lamhaat, and GitHub sends you
//      straight back to the app (OAuth with a loopback redirect, state and PKCE). Passwords, 2FA
//      (app, SMS, security key, passkey), Google/Apple sign-in and organisation SSO all happen on
//      GitHub's own page; the app only ever receives a token.
//   2. A code (device flow), for when the browser is on another device.
//   3. The GitHub CLI sign-in already on this PC (`gh auth login`).
//   4. A token you made yourself (classic with the "repo" scope, or fine-grained).
// GitHub Enterprise Server works too: give its address instead of github.com.
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { saveSecret, loadSecret, removeSecret } from './secrets.js';
import { setting, setSetting } from './db.js';

// The Lamhaat OAuth App, registered once by the app's owner. Its client id is public by design; its
// secret is kept like a sign-in (encrypted for this Windows account).
// ponytail: set through the app's one-time setup; bake both in here when Lamhaat ships to other people
// (every desktop app's OAuth secret is extractable anyway; the user's approval is what protects them).
const CLIENT_ID = '';
const key = host => host === 'github.com' ? 'githubClientId' : `githubClientId:${host}`;
export const clientId = host => setting(key(host), host === 'github.com' ? CLIENT_ID : '');
const clientSecret = host => loadSecret(`app-${host.replace(/[^a-z0-9.-]/g, '_')}`);
export function setApp(host, id, secret) {
  setSetting(key(host), id);
  if (secret) saveSecret(`app-${host.replace(/[^a-z0-9.-]/g, '_')}`, secret);
}
export const appReady = host => ({ code: !!clientId(host), browser: !!clientId(host) && !!clientSecret(host) });

export const urls = host => {
  if (host === 'github.com') return { api: 'https://api.github.com', web: 'https://github.com' };
  const web = `${/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https'}://${host}`; // plain http only for a server on this PC (tests)
  return { api: `${web}/api/v3`, web };
};
export const cleanHost = h => String(h || 'github.com').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase() || 'github.com';

// A problem the person can act on: what happened in plain words, and what can fix it.
export class Problem extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function request(auth, method, route, body) {
  let res;
  try {
    res = await fetch(urls(auth.host).api + route, {
      method, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60e3),
      headers: { authorization: `Bearer ${auth.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Lamhaat', ...(body && { 'content-type': 'application/json' }) },
    });
  } catch { throw new Problem('offline', `Can’t reach ${auth.host}. Check the internet connection.`); }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.ok) return { data, headers: res.headers };
  const msg = data?.message || res.statusText;
  const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000, retry = Number(res.headers.get('retry-after')) * 1000;
  if ((res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || retry)) {
    throw new Problem('rate', 'GitHub asked us to slow down.', { waitMs: Math.min(3600e3, Math.max(60e3, retry || reset - Date.now())) });
  }
  if (res.status === 401) throw new Problem('signin', 'GitHub no longer accepts this sign-in (it expired or was revoked). Sign in again.');
  if (res.status === 403 && /saml|sso|single sign-on/i.test(msg)) throw new Problem('sso', 'An organisation needs you to approve single sign-on for this sign-in. Sign in again and approve the organisation when GitHub asks.');
  if (res.status === 403) throw new Problem('scope', `GitHub refused: ${msg}. This sign-in may not be allowed to create or write repositories; sign in again and allow it.`);
  if (res.status === 404) throw new Problem('notfound', msg);
  if (res.status === 422) throw new Problem('conflict', `${msg}${data?.errors ? `: ${data.errors.map(e => e.message || e.code).join('; ')}` : ''}`);
  if (res.status >= 500) throw new Problem('server', `GitHub is having trouble right now (${res.status}).`);
  throw new Problem('other', `GitHub said: ${msg} (${res.status})`);
}
export const api = async (auth, method, route, body) => (await request(auth, method, route, body)).data;

// Who is this, and may the sign-in create and write repositories?
export async function check(auth) {
  const { data, headers } = await request(auth, 'GET', '/user');
  const scopes = headers.get('x-oauth-scopes'); // absent for fine-grained tokens: those are checked when used
  if (scopes != null && !scopes.split(',').map(s => s.trim()).includes('repo')) {
    throw new Problem('scope', `This sign-in can’t write to private repositories (it has: ${scopes || 'no permissions'}). Sign in again and allow repository access.`);
  }
  return { login: data.login, name: data.name };
}

// ---- the saved sign-in ----
export const current = () => { try { return JSON.parse(loadSecret('github')); } catch { return null; } };
// the saved sign-in, renewed first if it is one of GitHub's expiring ones (8 hours) and close to running out
export async function fresh() {
  const a = current();
  if (!a?.refresh || !a.expires || a.expires - Date.now() > 10 * 60e3) return a;
  if (a.refreshExpires && a.refreshExpires < Date.now()) throw new Problem('signin', 'The GitHub sign-in ran out (it lasts six months unless used). Sign in again.');
  const r = await post(`${urls(a.host).web}/login/oauth/access_token`, { client_id: clientId(a.host), ...(clientSecret(a.host) && { client_secret: clientSecret(a.host) }), grant_type: 'refresh_token', refresh_token: a.refresh });
  if (!r.access_token) throw new Problem('signin', 'GitHub didn’t renew the sign-in. Sign in again.');
  return save({ ...a, ...lifetimes(r), token: r.access_token });
}
// expiring sign-ins come with a renewal key and lifetimes; others have neither
const lifetimes = r => r.refresh_token ? { refresh: r.refresh_token, expires: Date.now() + r.expires_in * 1000, refreshExpires: r.refresh_token_expires_in ? Date.now() + r.refresh_token_expires_in * 1000 : null } : {};
export async function save(auth) {
  const who = await check(auth);
  const saved = { token: auth.token, host: auth.host, method: auth.method, login: who.login, name: who.name || null, at: new Date().toISOString(),
    ...(auth.refresh && { refresh: auth.refresh, expires: auth.expires, refreshExpires: auth.refreshExpires }) };
  saveSecret('github', JSON.stringify(saved));
  return saved;
}
// signing out also cancels the sign-in on GitHub when it came through your own GitHub app (GitHub lets the app
// do that); a pasted token or the GitHub CLI's can only be cancelled on GitHub's own settings page
export async function signOut() {
  const a = current();
  removeSecret('github');
  if (!a || !['browser', 'code'].includes(a.method) || !clientId(a.host) || !clientSecret(a.host)) return { revoked: false };
  const basic = Buffer.from(`${clientId(a.host)}:${clientSecret(a.host)}`).toString('base64');
  const r = await fetch(`${urls(a.host).api}/applications/${clientId(a.host)}/grant`, { method: 'DELETE', signal: AbortSignal.timeout(20e3),
    headers: { authorization: `Basic ${basic}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }, body: JSON.stringify({ access_token: a.token }) }).catch(() => null);
  return { revoked: r?.status === 204 };
}
export const publicAccount = a => a && { login: a.login, name: a.name, host: a.host, method: a.method, at: a.at };

// ---- 1. Sign in with GitHub: the browser, then straight back here ----
const waiting = new Map(); // state -> { host, verifier, redirect, until }; single use, 10 minutes
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function webStart(host, redirect) {
  const id = clientId(host);
  if (!id || !clientSecret(host)) throw new Problem('setup', 'Sign in with GitHub isn’t set up on this PC yet.');
  for (const [k, v] of waiting) if (v.until < Date.now()) waiting.delete(k);
  const state = b64url(crypto.randomBytes(24)), verifier = b64url(crypto.randomBytes(32));
  waiting.set(state, { host, verifier, redirect, until: Date.now() + 600e3 });
  const q = new URLSearchParams({ client_id: id, redirect_uri: redirect, scope: 'repo', state, allow_signup: 'true',
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
  const url = `${urls(host).web}/login/oauth/authorize?${q}`;
  // the person's normal browser, where they are probably signed in to GitHub already
  if (process.platform === 'win32' && !process.env.LAMHAAT_NO_BROWSER) spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return url;
}
export async function webFinish(params) {
  const w = waiting.get(params.get('state') || '');
  if (!w || w.until < Date.now()) throw new Problem('expired', 'This sign-in link is old or was already used. Start again from Lamhaat.');
  waiting.delete(params.get('state'));
  if (params.get('error')) throw new Problem(params.get('error') === 'access_denied' ? 'declined' : 'other',
    params.get('error') === 'access_denied' ? 'You chose not to allow Lamhaat on GitHub.' : params.get('error_description') || params.get('error'));
  const r = await post(`${urls(w.host).web}/login/oauth/access_token`, { client_id: clientId(w.host), client_secret: clientSecret(w.host), code: params.get('code'), redirect_uri: w.redirect, code_verifier: w.verifier });
  if (!r.access_token) throw new Problem('other', r.error === 'incorrect_client_credentials' ? 'The app’s Client secret is wrong. Enter it again in the one-time setup.' : r.error_description || r.error || 'GitHub sign-in failed.');
  return save({ token: r.access_token, host: w.host, method: 'browser', ...lifetimes(r) });
}

// ---- 2. a code (device flow) ----
async function post(url, body) {
  let res;
  try { res = await fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Lamhaat' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30e3) }); }
  catch { throw new Problem('offline', `Can’t reach ${new URL(url).host}. Check the internet connection and the address.`); }
  if (res.status === 404) throw new Problem('setup', 'GitHub doesn’t know this app’s Client ID. Check it was copied fully from the app’s page on GitHub.');
  return res.json().catch(() => ({}));
}
export async function deviceStart(host) {
  const id = clientId(host);
  if (!id) throw new Problem('setup', 'Sign-in codes aren’t set up yet: the app’s Client ID is missing.');
  const d = await post(`${urls(host).web}/login/device/code`, { client_id: id, scope: 'repo' });
  if (d.error) throw new Problem('setup', d.error === 'device_flow_disabled' ? 'Browser sign-in (device flow) is switched off for this app on GitHub.' : d.error_description || d.error);
  return { host, clientId: id, deviceCode: d.device_code, userCode: d.user_code, url: d.verification_uri, expiresAt: Date.now() + d.expires_in * 1000, interval: d.interval || 5 };
}
// waits until the person approves (or declines, or the code runs out); `cancelled()` stops it
export async function deviceWait(start, cancelled = () => false) {
  let interval = start.interval;
  while (Date.now() < start.expiresAt) {
    await sleep(interval * 1000);
    if (cancelled()) throw new Problem('cancelled', 'Sign-in cancelled.');
    let r;
    try { r = await post(`${urls(start.host).web}/login/oauth/access_token`, { client_id: start.clientId, device_code: start.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }); }
    catch (e) { if (e.kind === 'offline') continue; throw e; } // a dropped connection mid-wait: keep waiting
    if (r.access_token) return save({ token: r.access_token, host: start.host, method: 'code', ...lifetimes(r) });
    if (r.error === 'authorization_pending') continue;
    if (r.error === 'slow_down') { interval = (r.interval || interval + 5); continue; }
    if (r.error === 'access_denied') throw new Problem('declined', 'The sign-in was declined on GitHub.');
    if (r.error === 'expired_token') break;
    throw new Problem('other', r.error_description || r.error || 'GitHub sign-in failed.');
  }
  throw new Problem('expired', 'The code ran out before it was approved. Start again for a new one.');
}

// ---- 3. the GitHub CLI's sign-in ----
export function fromCli(host) {
  return new Promise((resolve, reject) => execFile('gh', ['auth', 'token', '--hostname', host], { windowsHide: true, timeout: 20e3 }, (err, out) => {
    if (err?.code === 'ENOENT') return reject(new Problem('nocli', 'The GitHub CLI (gh) isn’t installed on this PC.'));
    const token = String(out || '').trim();
    if (err || !token) return reject(new Problem('nocli', `The GitHub CLI isn’t signed in to ${host}. Run “gh auth login” first, or use another way.`));
    resolve(save({ token, host, method: 'cli' }).catch(reject));
  }));
}

// ---- 4. a token the person made ----
export function fromToken(host, token) {
  token = String(token || '').trim();
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) return Promise.reject(new Problem('badtoken', 'That doesn’t look like a GitHub token. It starts with ghp_ or github_pat_.'));
  return save({ token, host, method: 'token' }).catch(e => {
    throw e.kind === 'signin' ? new Problem('badtoken', 'GitHub didn’t accept that token. Check it was copied in full and hasn’t expired.') : e;
  });
}

// git with this sign-in attached through the environment (never on a command line or in a URL),
// and no other credential helper or prompt getting in the way
export function gitEnv(auth) {
  const basic = Buffer.from(`x-access-token:${auth.token}`).toString('base64');
  return {
    ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: `http.${urls(auth.host).web}/.extraheader`, GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}
