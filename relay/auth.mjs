// Sign-in with Google (D-45), the same way Continuum does it (Martin): no passwords of our own to store, leak or
// reset, and Google's two-step verification guards the account that can change the household's settings.
// Everything the relay serves needs a signed-in person, except the real phone, which proves itself with PHONE_TOKEN.
//
//   /signin              the sign-in page          /auth/google    off to Google
//   /auth/callback       back from Google          /auth/signout   ends the session
//
// Who may sign in: OWNER_EMAILS (.env, always allowed, so nobody is locked out) plus the settings page's list.
// Sessions are a signed cookie (no database): the email and an expiry, HMAC'd with SESSION_SECRET. The email is
// checked against the list on every request, so removing someone takes effect at once.
// Without GOOGLE_CLIENT_ID the relay is open, which is allowed only off Railway (a home-network relay).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { settings } from './settings.mjs';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SECRET = process.env.SESSION_SECRET || '';
const PHONE_TOKEN = process.env.PHONE_TOKEN || '';
const OWNERS = (process.env.OWNER_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const SESSION_DAYS = 30;
const COOKIE = 'switchboard_session';
const STATE_COOKIE = 'switchboard_signin';
const ON_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT);

export const authEnabled = Boolean(CLIENT_ID);

// Called at startup: refuses to run a public relay without sign-in, and says what is missing.
export function checkAuthConfig() {
  // Deploys skip .gitignore (it dropped the clips, T-038), so .railwayignore alone keeps secrets off Railway: check it.
  if (ON_RAILWAY) console.log(fs.existsSync('.env') ? 'WARNING: a .env file was uploaded to Railway; check .railwayignore' : 'No .env uploaded (good)');
  if (!authEnabled) {
    if (ON_RAILWAY) throw new Error('GOOGLE_CLIENT_ID is not set: refusing to run on Railway without sign-in');
    console.log('Sign-in is OFF (no GOOGLE_CLIENT_ID): fine on the home network only');
    return;
  }
  const missing = ['GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'OWNER_EMAILS'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Sign-in needs ${missing.join(', ')} in .env`);
  if (SECRET.length < 32) throw new Error('SESSION_SECRET should be at least 32 characters');
  if (!PHONE_TOKEN) console.log('No PHONE_TOKEN: only signed-in browsers can connect, not the real phone');
  console.log(`Sign-in with Google is on (${OWNERS.length} owner${OWNERS.length === 1 ? '' : 's'})`);
}

const allowed = (email) => {
  const e = email.toLowerCase();
  return OWNERS.includes(e) || (settings().access?.emails ?? []).some((x) => x.toLowerCase() === e);
};

// --- Signed values ("payload.signature"), used for the session and the sign-in state.
const sign = (value) => {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};
function unsign(token) {
  const [body, mac] = (token ?? '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('='))
  .filter(([k, v]) => k && v).map(([k, v]) => [k, decodeURIComponent(v)]));
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
const cookie = (req, name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
// The address Google sends people back to. PUBLIC_URL wins (Railway's domain); otherwise this request's own host.
const origin = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
// Only same-site paths after sign-in, so the sign-in can't be used to bounce someone elsewhere.
const safeNext = (next) => (typeof next === 'string' && /^\/(?!\/)/.test(next) ? next : '/');

// The signed-in person's email, or null.
export function signedIn(req) {
  if (!authEnabled) return 'home network';
  const s = unsign(cookies(req)[COOKIE]);
  return s && s.exp > Date.now() && typeof s.email === 'string' && allowed(s.email) ? s.email : null;
}

// May this WebSocket connect to /phone? A signed-in browser, or the real phone with its token.
export function phoneAllowed(req) {
  if (signedIn(req)) return true;
  if (!PHONE_TOKEN) return false;
  const given = new URL(req.url, 'http://relay').searchParams.get('token') || (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const a = crypto.createHash('sha256').update(given).digest(); const b = crypto.createHash('sha256').update(PHONE_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

const page = (res, status, title, body) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(fs.readFileSync('softphone/signin.html', 'utf8').replaceAll('{{title}}', title).replace('{{body}}', body));
};
const escape = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Handles the sign-in routes, and turns away anyone not signed in. Returns true if it answered the request.
export async function handleAuth(req, res) {
  if (!authEnabled) return false;
  const url = new URL(req.url, 'http://relay');
  const p = url.pathname;

  if (p === '/signin') {
    const next = safeNext(url.searchParams.get('next'));
    page(res, 200, 'Sign in', `<p>The switchboard is private to the household.</p>
      <a class="google" href="/auth/google?next=${encodeURIComponent(next)}">Continue with Google</a>`);
    return true;
  }
  if (p === '/auth/google') {
    const state = crypto.randomBytes(16).toString('base64url');
    const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: `${origin(req)}/auth/callback`, response_type: 'code',
      scope: 'openid email', state, prompt: 'select_account' });
    res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?${q}`,
      'set-cookie': cookie(req, STATE_COOKIE, sign({ state, next: safeNext(url.searchParams.get('next')), exp: Date.now() + 600_000 }), 600) });
    res.end();
    return true;
  }
  if (p === '/auth/callback') {
    const saved = unsign(cookies(req)[STATE_COOKIE]);
    const clear = cookie(req, STATE_COOKIE, '', 0);
    if (!saved || saved.exp < Date.now() || saved.state !== url.searchParams.get('state') || !url.searchParams.get('code')) {
      res.setHeader('set-cookie', clear);
      page(res, 400, 'Sign-in expired', '<p>That sign-in took too long or was interrupted.</p><a class="google" href="/signin">Try again</a>');
      return true;
    }
    let email;
    try { email = await exchange(url.searchParams.get('code'), `${origin(req)}/auth/callback`); } catch (err) {
      console.log(`Sign-in failed: ${err.message}`);
      res.setHeader('set-cookie', clear);
      page(res, 502, 'Sign-in failed', '<p>Google didn\'t confirm the sign-in.</p><a class="google" href="/signin">Try again</a>');
      return true;
    }
    if (!allowed(email)) {
      console.log(`Sign-in refused: ${email} is not on the list`);
      res.setHeader('set-cookie', clear);
      page(res, 403, 'Not on the list', `<p>${escape(email)} isn't one of the household's accounts. Someone who is can add it on the settings page.</p>
        <a class="google" href="/auth/google">Use another account</a>`);
      return true;
    }
    console.log(`Signed in: ${email}`);
    res.writeHead(302, { location: saved.next, 'set-cookie': [clear,
      cookie(req, COOKIE, sign({ email, exp: Date.now() + SESSION_DAYS * 86_400_000 }), SESSION_DAYS * 86_400)] });
    res.end();
    return true;
  }
  if (p === '/auth/signout') {
    res.writeHead(302, { location: '/signin', 'set-cookie': cookie(req, COOKIE, '', 0) });
    res.end();
    return true;
  }
  if (p === '/api/me') {
    const email = signedIn(req);
    res.writeHead(email ? 200 : 401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(email ? { email, owner: OWNERS.includes(email.toLowerCase()) } : { error: 'Not signed in' }));
    return true;
  }

  if (signedIn(req)) return false; // carry on to the page or API
  if (p.startsWith('/api/')) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not signed in' }));
  } else {
    res.writeHead(302, { location: `/signin?next=${encodeURIComponent(p + url.search)}` }).end();
  }
  return true;
}

// Trades Google's one-time code for the person's verified email. The ID token comes straight from Google's token
// endpoint over TLS, which OpenID Connect (Core 3.1.3.7) accepts in place of checking its signature; the audience,
// issuer, expiry and email verification are still checked.
async function exchange(code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) throw new Error(body.error_description || body.error || `token endpoint ${res.status}`);
  const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url').toString('utf8'));
  if (claims.aud !== CLIENT_ID) throw new Error('token was for another app');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('token not from Google');
  if (claims.exp * 1000 < Date.now()) throw new Error('token expired');
  if (!claims.email || claims.email_verified !== true) throw new Error('email not verified by Google');
  return claims.email.toLowerCase();
}
