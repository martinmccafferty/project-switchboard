// The settings page's API (D-37, D-39), served by the relay next to the softphone:
//   GET  /api/settings          the household's settings
//   PUT  /api/settings          replace them (checked first, so a bad save can't break the phone)
//   GET  /api/place?q=...       look a place up ("Morrisville, NC" -> full name and time zone)
//   GET  /api/devices           the SwitchBot account's blinds and curtains (read-only)
// Only signed-in household members reach these (auth.mjs, D-45).
import { settings, updateSettings } from './settings.mjs';
import { geocode } from './home.mjs';
import { listDevices } from './switchbot.mjs';

const KINDS = { 'Blind Tilt': 'blind', Curtain: 'curtain', Curtain3: 'curtain' };
const str = (v, max = 200) => typeof v === 'string' && v.length <= max;
const strList = (v, max = 40) => Array.isArray(v) && v.length <= max && v.every((x) => str(x, 80));

// Returns an error message, or null if the settings are sound.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function check({ household: h, home, news, access }) {
  if (!h || !home) return 'Settings need a household and a home section.';
  if (!str(h.location, 120) || !h.location.trim()) return 'Home location is needed.';
  try { new Intl.DateTimeFormat('en-US', { timeZone: h.timezone }); } catch { return `Unknown time zone "${h.timezone}".`; }
  if (!['fahrenheit', 'celsius'].includes(h.temperatureUnit)) return 'Temperature unit must be Fahrenheit or Celsius.';
  if (!strList(h.transcribeKeywords, 100)) return 'Words to expect must be a list of short words.';
  if (!str(home.layout ?? '', 400) || !Array.isArray(home.groups) || home.groups.length > 30) return 'The rooms section is malformed.';
  const emails = access?.emails ?? [];
  if (!Array.isArray(emails) || emails.length > 20) return 'Up to twenty people can sign in.';
  const bad = emails.find((e) => !str(e, 120) || !EMAIL.test(e));
  if (bad !== undefined) return `"${bad}" isn't an email address.`;
  const feeds = news?.feeds ?? [];
  if (!Array.isArray(feeds) || feeds.length > 10) return 'The news line takes up to ten feeds.';
  for (const f of feeds) {
    if (!str(f.name, 60) || !f.name.trim()) return 'Each news feed needs a name.';
    if (!str(f.url, 300) || !/^https?:\/\/\S+$/.test(f.url)) return `"${f.name}" needs a web address starting http.`;
  }
  const ids = home.groups.map((g) => g.id);
  for (const g of home.groups) {
    if (!/^[a-z0-9_]{1,40}$/.test(g.id ?? '')) return `Group id "${g.id}" must be lowercase letters, digits or _.`;
    if (ids.filter((x) => x === g.id).length > 1) return `Two groups share the id "${g.id}".`;
    if (!str(g.name, 80) || !g.name.trim()) return `Group "${g.id}" needs a name.`;
    if (!str(g.where ?? '', 200) || !strList(g.callersSay ?? []) || !strList(g.offerNext ?? [])) return `Group "${g.name}" is malformed.`;
    const missing = (g.offerNext ?? []).find((x) => !ids.includes(x) || x === g.id);
    if (missing) return `"${g.name}" offers "${missing}", which isn't another group.`;
    if (!Array.isArray(g.devices) || !g.devices.length) return `"${g.name}" needs at least one device.`;
    for (const d of g.devices) {
      if (!str(d.id, 40) || !str(d.name, 80) || !['blind', 'curtain'].includes(d.kind)) return `A device in "${g.name}" is malformed.`;
    }
  }
  return null;
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const parts = [];
  req.on('data', (c) => { size += c.length; if (size > 100_000) { reject(new Error('too large')); req.destroy(); } else parts.push(c); });
  req.on('end', () => resolve(Buffer.concat(parts).toString('utf8'))); req.on('error', reject);
});

// Handles /api/... requests; returns false for anything else. onSaved() runs after a successful save.
export async function handleSettingsApi(req, res, { onSaved = () => {} } = {}) {
  const url = new URL(req.url, 'http://relay');
  if (!url.pathname.startsWith('/api/')) return false;
  try {
    if (url.pathname === '/api/settings' && req.method === 'GET') return send(res, 200, settings()), true;
    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      let next; try { next = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'That wasn\'t valid settings data.' }), true; }
      const problem = check(next);
      if (problem) return send(res, 400, { error: problem }), true;
      if (!(await geocode(next.household.location))) return send(res, 400, { error: `Couldn't find "${next.household.location}".` }), true;
      const saved = updateSettings({ household: next.household, home: next.home, news: { feeds: next.news?.feeds ?? [] },
        access: { emails: (next.access?.emails ?? []).map((e) => e.trim().toLowerCase()) } });
      onSaved(saved);
      return send(res, 200, saved), true;
    }
    if (url.pathname === '/api/place' && req.method === 'GET') {
      const place = await geocode(url.searchParams.get('q') ?? '');
      return send(res, place ? 200 : 404, place ?? { error: 'Not found' }), true;
    }
    if (url.pathname === '/api/devices' && req.method === 'GET') {
      const { deviceList = [] } = await listDevices();
      return send(res, 200, deviceList.filter((d) => KINDS[d.deviceType]).map((d) => ({ id: d.deviceId, name: d.deviceName, kind: KINDS[d.deviceType] }))), true;
    }
    return send(res, 404, { error: 'Not found' }), true;
  } catch (err) {
    return send(res, 500, { error: err.message }), true;
  }
}
