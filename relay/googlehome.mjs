// Google Home, read and worked through Google's Home MCP server (D-50, Q-18): an owner connects the household's
// Google Home once, with Google's own consent screen, and the relay can then see every room and device by the names
// used in Google Home, read their state and run actions. Nothing to pair or name by hand.
//   /auth/google-home            (owners only) off to Google to grant access
//   /auth/google-home/callback   back from Google; the refresh token is kept in data/google-home.json
//   GET /api/google-home         connected or not, and a summary of homes, rooms and devices
//   POST /api/google-home/disconnect
// Requires Google Home Premium Advanced, the "Home API" enabled in the Google Cloud project, and this relay's
// callback addresses on the OAuth client. Run on its own to print what it can see:  node --env-file=.env googlehome.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { oauth, ownerSignedIn } from './auth.mjs';

const MCP_URL = 'https://home.googleapis.com/mcp';
const SCOPE = 'https://www.googleapis.com/auth/home.platform.v2';
const FILE = process.env.GOOGLE_HOME_FILE || 'data/google-home.json';
const STATE_COOKIE = 'switchboard_google_home';

// --- The stored grant: { refresh_token, access_token, expires_at, connected_by, connected_at }. A secret: never sent to a browser.
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
function store(grant) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(grant, null, 2), { mode: 0o600 });
  fs.renameSync(`${FILE}.tmp`, FILE);
}
export const googleHomeConnected = () => Boolean(load()?.refresh_token);

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: oauth.clientId, client_secret: oauth.clientSecret, ...params }), signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.error || `token endpoint ${res.status}`);
  return body;
}
// A current access token, refreshed a minute before it runs out.
async function accessToken() {
  const g = load();
  if (!g?.refresh_token) throw new Error('Google Home is not connected');
  if (g.access_token && g.expires_at > Date.now() + 60_000) return g.access_token;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: g.refresh_token });
  store({ ...g, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}

// --- The MCP connection, opened when first needed and reopened if it fails.
let client = null;
async function mcp() {
  if (client) return client;
  const token = await accessToken();
  const c = new Client({ name: 'switchboard-relay', version: '0.2.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  client = c;
  setTimeout(() => { if (client === c) { client = null; c.close().catch(() => {}); } }, 45 * 60_000); // before the token expires
  return c;
}
export async function googleHomeTools() { return (await (await mcp()).listTools()).tools; }
export async function callGoogleHome(name, args = {}) {
  try {
    const r = await (await mcp()).callTool({ name, arguments: args });
    return r.structuredContent ?? r.content?.map((x) => x.text ?? '').join('\n');
  } catch (err) { client = null; throw err; }
}

// --- Routes.
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
export async function handleGoogleHome(req, res) {
  const url = new URL(req.url, 'http://relay');
  const p = url.pathname;
  if (!['/auth/google-home', '/auth/google-home/callback', '/api/google-home', '/api/google-home/disconnect'].includes(p)) return false;
  const callback = `${oauth.origin(req)}/auth/google-home/callback`;

  if (p === '/api/google-home' && req.method === 'GET') {
    const g = load();
    if (!g?.refresh_token) return json(res, 200, { connected: false }), true;
    try {
      const homes = await callGoogleHome('list_homes');
      return json(res, 200, { connected: true, connected_by: g.connected_by, homes }), true;
    } catch (err) { return json(res, 200, { connected: true, connected_by: g.connected_by, error: err.message }), true; }
  }
  if (!ownerSignedIn(req)) return json(res, 403, { error: 'Only an owner can connect or disconnect Google Home.' }), true;

  if (p === '/auth/google-home') {
    const state = crypto.randomBytes(16).toString('base64url');
    const q = new URLSearchParams({ client_id: oauth.clientId, redirect_uri: callback, response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?${q}`,
      'set-cookie': oauth.cookie(req, STATE_COOKIE, oauth.sign({ state, exp: Date.now() + 600_000 }), 600) });
    res.end(); return true;
  }
  if (p === '/auth/google-home/callback') {
    const saved = oauth.unsign(oauth.cookies(req)[STATE_COOKIE]);
    const clear = oauth.cookie(req, STATE_COOKIE, '', 0);
    const back = (result) => { res.writeHead(302, { location: `/settings?google_home=${result}`, 'set-cookie': clear }); res.end(); return true; };
    if (url.searchParams.get('error')) return back('declined');
    if (!saved || saved.exp < Date.now() || saved.state !== url.searchParams.get('state')) return back('expired');
    try {
      const t = await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: callback });
      if (!t.refresh_token) throw new Error('Google gave no refresh token');
      store({ refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000,
        scope: t.scope, connected_by: (await import('./auth.mjs')).signedIn(req), connected_at: Date.now() });
      client = null;
      console.log('Google Home connected');
      (await import('./house.mjs')).refreshHouse(); // learn the rooms and devices straight away (D-51)
      return back('connected');
    } catch (err) { console.log(`Google Home connection failed: ${err.message}`); return back('failed'); }
  }
  if (p === '/api/google-home/disconnect' && req.method === 'POST') {
    const g = load();
    if (g?.refresh_token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(g.refresh_token)}`, { method: 'POST' }).catch(() => {});
    try { fs.unlinkSync(FILE); } catch { /* already gone */ }
    client = null;
    console.log('Google Home disconnected');
    (await import('./house.mjs')).refreshHouse(); // the lights go back to the home bridge
    return json(res, 200, { connected: false }), true;
  }
  return json(res, 404, { error: 'Not found' }), true;
}

// Run on its own: what the relay can see of the connected Google Home.
if (import.meta.url === `file://${process.argv[1]}`) {
  const tools = await googleHomeTools();
  console.log('Tools:', tools.map((t) => t.name).join(', '));
  console.log(JSON.stringify(await callGoogleHome('list_homes'), null, 2).slice(0, 3000));
  process.exit(0);
}
