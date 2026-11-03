// A stand-in for Firebase on this PC, for testing sharing without a real project: Google's token
// renewal (securetoken) and Firestore's web interface, with the Lamhaat rules acted out: only the owner
// writes the lists; a viewer reads their own access list, "_everyone", "_public", and albums listed for
// them; their own favourites; comments under albums they can see; and they can ask for access.
import http from 'node:http';
import crypto from 'node:crypto';

export async function fakeFirebase({ owner, project = 'lamhaat-test' }) {
  const docs = new Map(); // 'albums/x' -> fields (Firestore's typed form)
  const state = { mode: 'ok', writes: 0, rules: 2 }; // mode: ok | locked (rules not pasted) | nodb; rules: 1 = the older ones
  const jwt = (email, exp = 3600) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ email, email_verified: true, exp: Math.floor(Date.now() / 1000) + exp })).toString('base64url')}.x`;
  const refreshFor = new Map([['owner-refresh', owner]]);
  const who = req => { try { return JSON.parse(Buffer.from(String(req.headers.authorization).split(' ')[1].split('.')[1], 'base64url')).email; } catch { return null; } };
  const dec = v => 'stringValue' in v ? v.stringValue : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : v;
  const listed = (list, id) => (docs.get(list)?.albums ? dec(docs.get(list).albums) : []).includes(id);
  const sees = (email, id) => [`access/${email}`, 'access/_everyone'].some(p => listed(p, id));
  const canSee = (email, id) => email === owner || sees(email, id) || (!!email && listed('access/_public', id));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = ''; for await (const c of req) body += c;
    const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/v1/token') {
      const email = refreshFor.get(new URLSearchParams(body).get('refresh_token'));
      return email ? send(200, { id_token: jwt(email), refresh_token: 'owner-refresh', expires_in: '3600' }) : send(400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
    }
    const m = /^\/v1\/projects\/([^/]+)\/databases\/\(default\)\/documents\/(.+)$/.exec(decodeURIComponent(url.pathname));
    if (!m || m[1] !== project) return send(404, { error: { message: 'not found' } });
    if (state.mode === 'nodb') return send(404, { error: { message: 'The database (default) does not exist' } });
    const email = who(req), path = m[2], isOwner = email === owner, parts = path.split('/');
    const denied = () => send(403, { error: { message: 'Missing or insufficient permissions.' } });
    if (state.mode === 'locked' && !isOwner) return denied();
    const newer = parts[0] === 'favs' || parts[0] === 'comments' || parts[0] === 'requests';
    if (newer && state.rules < 2) return denied(); // the older rules don't know these
    const docsUnder = prefix => [...docs].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
    const listOut = rows => send(200, { documents: rows.map(([p, fields]) => ({ name: `projects/${project}/databases/(default)/documents/${p}`, fields })) });

    // comments: POST to an album's list adds one; a viewer must be able to see the album and sign as themselves
    if (parts[0] === 'comments' && parts[2] === 'items') {
      const album = parts[1];
      if (req.method === 'POST' && parts.length === 3) {
        const f = JSON.parse(body).fields || {};
        const text = f.text ? dec(f.text) : '';
        if (!canSee(email, album) || (f.by ? dec(f.by) : '') !== email || !text || text.length > 1000) return denied();
        const p = `${path}/${crypto.randomBytes(8).toString('hex')}`;
        docs.set(p, f);
        return send(200, { name: `projects/${project}/databases/(default)/documents/${p}`, fields: f });
      }
      if (req.method === 'GET' && parts.length === 3) return canSee(email, album) ? listOut(docsUnder(`${path}/`)) : denied();
      if (req.method === 'DELETE' && parts.length === 4) { const d = docs.get(path); if (!isOwner && !(d && dec(d.by) === email)) return denied(); docs.delete(path); return send(200, {}); }
    }
    if (parts[0] === 'favs') {
      if (!email || parts[1] !== email) return denied();
      if (req.method === 'PATCH') { docs.set(path, JSON.parse(body).fields); return send(200, { name: path, fields: docs.get(path) }); }
      if (req.method === 'DELETE') { docs.delete(path); return send(200, {}); }
      return docs.has(path) ? send(200, { name: path, fields: docs.get(path) }) : send(404, { error: { message: 'not found' } });
    }
    if (parts[0] === 'requests') {
      if (parts.length === 1) return isOwner && req.method === 'GET' ? listOut(docsUnder('requests/')) : denied();
      if (req.method === 'PATCH') { if (!email || parts[1] !== email) return denied(); docs.set(path, JSON.parse(body).fields); return send(200, { name: path, fields: docs.get(path) }); }
      if (req.method === 'DELETE') { if (!isOwner) return denied(); docs.delete(path); return send(200, {}); }
    }
    if (req.method === 'PATCH' || req.method === 'DELETE') {
      if (!isOwner || state.mode === 'locked') return denied();
      state.writes++;
      if (req.method === 'DELETE') { docs.delete(path); return send(200, {}); }
      docs.set(path, JSON.parse(body).fields);
      return send(200, { name: path, fields: docs.get(path) });
    }
    if (path === 'albums') return isOwner ? listOut(docsUnder('albums/')) : denied(); // a list: owner only
    if (!email) return denied();
    const [col, id] = parts;
    const ok = isOwner || (col === 'access' && (id === email || id === '_everyone' || id === '_public')) || (col === 'albums' && sees(email, id));
    if (!ok) return denied();
    return docs.has(path) ? send(200, { name: path, fields: docs.get(path) }) : send(404, { error: { message: 'not found' } });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, docs, state, jwt, read: p => docs.has(p) ? Object.fromEntries(Object.entries(docs.get(p)).map(([k, v]) => [k, dec(v)])) : null, close: () => new Promise(r => server.close(r)) };
}
