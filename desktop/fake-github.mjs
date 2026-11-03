// A stand-in GitHub on this PC, for testing the publishing agent without touching a real account:
// real git over HTTP (git http-backend, part of Git for Windows) plus the few REST calls the agent
// makes (user, repositories, file contents, Pages). Pages "builds" instantly and serves the site repo.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export async function fakeGitHub(root, { login = 'tester' } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const repos = new Map(); // name -> { private, pages }
  const bare = name => path.join(root, login, `${name}.git`);
  const git = (name, ...args) => execFileSync('git', ['--git-dir', bare(name), ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  const head = name => { try { return git(name, 'rev-parse', 'refs/heads/main').toString().trim(); } catch { return null; } };
  const show = (name, file) => { try { return git(name, 'show', `main:${file}`); } catch { return null; } };
  const counts = { pushes: 0, created: [] };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, data, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
    const body = () => new Promise(r => { let s = ''; req.on('data', d => s += d); req.on('end', () => r(s ? JSON.parse(s) : {})); });
    let m;
    // ---- git ----
    if ((m = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(url.pathname))) {
      if (!repos.has(m[2])) return json(404, { message: 'Repository not found' });
      if (m[3] === '/git-receive-pack') counts.pushes++;
      const cgi = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: login,
        REQUEST_METHOD: req.method, PATH_INFO: `/${m[1]}/${m[2]}.git${m[3]}`, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '',
        GIT_PROTOCOL: req.headers['git-protocol'] || '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '' } });
      req.pipe(cgi.stdin);
      let buf = Buffer.alloc(0), headed = false;
      cgi.stdout.on('data', d => {
        if (headed) return res.write(d);
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const headers = {}; let status = 200;
        for (const line of buf.subarray(0, end).toString().split('\r\n')) {
          const [k, ...v] = line.split(':'); const val = v.join(':').trim();
          if (k.toLowerCase() === 'status') status = parseInt(val); else headers[k] = val;
        }
        res.writeHead(status, headers); headed = true; res.write(buf.subarray(end + 4));
      });
      cgi.on('close', () => res.end());
      return;
    }
    // ---- the published site ----
    if ((m = /^\/pages\/[^/]+\/([^/]+)\/(.*)$/.exec(url.pathname))) {
      const f = show(m[1], m[2] || 'index.html');
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200); return res.end(f);
    }
    // ---- renewing an expiring sign-in ----
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const b = await body();
      if (b.grant_type !== 'refresh_token' || b.refresh_token !== 'renew-me') return json(200, { error: 'bad_refresh_token' });
      counts.renewed = (counts.renewed || 0) + 1;
      return json(200, { access_token: `renewed-${counts.renewed}`, expires_in: 28800, refresh_token: 'renew-me', refresh_token_expires_in: 15897600 });
    }
    // ---- REST ----
    const p = url.pathname.replace(/^\/api\/v3/, '');
    // signing out: the app cancels its own sign-in (needs the app's id and secret)
    if (req.method === 'DELETE' && /^\/applications\/[^/]+\/grant$/.test(p)) {
      const b = await body();
      if (!String(req.headers.authorization).startsWith('Basic ')) return json(401, {});
      counts.revoked = [...(counts.revoked || []), b.access_token];
      res.writeHead(204); return res.end();
    }
    if (p === '/user') return json(200, { login, name: 'Test Person' }, { 'x-oauth-scopes': 'repo' });
    if (req.method === 'POST' && p === '/user/repos') {
      const b = await body();
      fs.mkdirSync(bare(b.name), { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare(b.name)]);
      git(b.name, 'config', 'http.receivepack', 'true'); git(b.name, 'config', 'uploadpack.allowFilter', 'true'); git(b.name, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
      repos.set(b.name, { private: !!b.private, pages: null }); counts.created.push(b.name);
      return json(201, { name: b.name, private: !!b.private });
    }
    if ((m = /^\/repos\/[^/]+\/([^/]+)$/.exec(p))) {
      const r = repos.get(m[1]);
      if (!r) return json(404, { message: 'Not Found' });
      if (req.method === 'PATCH') Object.assign(r, { private: (await body()).private });
      return json(200, { name: m[1], private: r.private });
    }
    if ((m = /^\/repos\/[^/]+\/([^/]+)\/contents\/(.+)$/.exec(p))) {
      const f = repos.has(m[1]) && show(m[1], m[2]);
      if (!f) return json(404, { message: 'Not Found' });
      if (/raw/.test(req.headers.accept || '')) { res.writeHead(200); return res.end(f); } // the Worker asks for the file itself
      return json(200, { content: f.toString('base64') });
    }
    if ((m = /^\/repos\/[^/]+\/([^/]+)\/git\/blobs\/([0-9a-f]{40})$/.exec(p))) {
      let f = null;
      try { f = repos.has(m[1]) && git(m[1], 'cat-file', 'blob', m[2]); } catch {}
      if (!f) return json(404, { message: 'Not Found' });
      res.writeHead(200); return res.end(f);
    }
    if ((m = /^\/repos\/[^/]+\/([^/]+)\/pages(\/builds\/latest)?$/.exec(p))) {
      const r = repos.get(m[1]);
      if (!r) return json(404, { message: 'Not Found' });
      const html_url = `http://${req.headers.host}/pages/${login}/${m[1]}/`;
      if (req.method === 'POST') { r.pages = html_url; return json(201, { html_url }); }
      if (!r.pages) return json(404, { message: 'Not Found' });
      return m[2] ? json(200, { status: 'built', commit: head(m[1]) }) : json(200, { html_url, status: 'built' });
    }
    json(404, { message: 'Not Found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${server.address().port}`;
  const commits = name => Number(git(name, 'rev-list', '--count', 'main').toString().trim()); // how long its history is
  return { host, counts, repos, show, head, commits, close: () => new Promise(r => server.close(r)) };
}
