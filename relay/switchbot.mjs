// SwitchBot cloud API v1.1 (M4): the blinds and the curtain. Needs SWITCHBOT_TOKEN and SWITCHBOT_SECRET in .env.
// Run on its own to list the account's devices (read-only):  node --env-file=.env switchbot.mjs   (--draft: see the end)
import crypto from 'node:crypto';
import { settings } from './settings.mjs';
import { lightsForPersona, lightsSummary } from './lights.mjs';
import { houseThermostats, houseForPersona } from './house.mjs';

const API = 'https://api.switch-bot.com/v1.1';

// Every request is signed: HMAC-SHA256 over token + time + nonce, keyed with the secret.
async function request(method, path, body) {
  const token = process.env.SWITCHBOT_TOKEN; const secret = process.env.SWITCHBOT_SECRET;
  if (!token || !secret) throw new Error('SWITCHBOT_TOKEN and SWITCHBOT_SECRET are not set');
  const t = String(Date.now()); const nonce = crypto.randomUUID();
  const sign = crypto.createHmac('sha256', secret).update(token + t + nonce).digest('base64').toUpperCase();
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: token, sign, t, nonce, 'Content-Type': 'application/json; charset=utf8' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.statusCode !== 100) throw new Error(`SwitchBot ${res.status} ${json.statusCode ?? ''} ${json.message ?? ''}`.trim());
  return json.body;
}

export const listDevices = () => request('GET', '/devices');
export const deviceStatus = (id) => request('GET', `/devices/${id}/status`);
// SWITCHBOT_DRY_RUN=1: commands are logged, not sent (for testing what Doris and the porter do without
// moving anything).
export const sendCommand = (id, command, parameter = 'default') => (process.env.SWITCHBOT_DRY_RUN
  ? (console.log(`(dry run) ${id}: ${command} ${parameter}`), Promise.resolve({}))
  : request('POST', `/devices/${id}/commands`, { command, parameter, commandType: 'command' }));

// --- The house comes from the settings (home.groups, D-38): each group has an id, a name ("the living room
// blinds"), where it is, what callers call it, its devices ({ id, name, kind: blind | curtain }), and which
// groups to offer next. Read live, so a change to the rooms applies to the next call.
const groups = () => settings().home?.groups ?? [];
const group = (id) => groups().find((g) => g.id === id);
const LOW_BATTERY = 15;

// Blind Tilt: closeDown tilts the slats shut (Martin: "exactly what I would expect"), fullyOpen levels them.
// Curtain: setPosition "index,mode,position" with position 0 = open, 100 = closed.
const COMMANDS = {
  blind: { open: ['fullyOpen'], close: ['closeDown'] },
  curtain: { open: ['setPosition', '0,ff,0'], close: ['setPosition', '0,ff,100'], half: ['setPosition', '0,ff,50'] },
};

// Doris's tools for this household's rooms (none if no rooms are set up).
export function homeTools() {
  const gs = groups();
  if (!gs.length) return [];
  const hasCurtains = gs.some((g) => g.devices.some((d) => d.kind === 'curtain'));
  return [
    {
      name: 'move_blinds',
      description: `Open or close the household's blinds and curtains. Groups: ${gs.map((g) => `${g.id} (${g.where ?? g.name})`).join('; ')}. `
        + `Blinds open or close${hasCurtains ? '; curtains can also go half open' : ''}. Takes a few seconds to move; `
        + 'confirm it to the caller once this succeeds.',
      input_schema: {
        type: 'object',
        properties: {
          groups: { type: 'array', items: { type: 'string', enum: gs.map((g) => g.id) }, description: 'Which to move.' },
          action: { type: 'string', enum: hasCurtains ? ['open', 'close', 'half'] : ['open', 'close'],
            description: hasCurtains ? '"half" works only for curtains.' : undefined },
        },
        required: ['groups', 'action'],
      },
    },
    {
      name: 'blinds_status',
      description: 'Where each blind and curtain is now (open, closed or part way), and any low batteries.',
      input_schema: { type: 'object', properties: {} },
    },
  ];
}

// What Doris knows about the rooms, for her persona ('' if none are set up).
export function homeForPersona() {
  const gs = groups(); const home = settings().home ?? {};
  if (!gs.length) return '';
  const name = (id) => group(id)?.name ?? id;
  const lines = [
    `- The blinds and curtains. ${home.layout ?? ''} The groups: ${gs.map((g) => `${g.name} (${g.where ?? ''})`).join('; ')}.`,
    ...gs.filter((g) => g.callersSay?.length).map((g) => `  ${g.callersSay.map((c) => `"${c}"`).join(' or ')} means ${g.name}.`),
    // Every time, opening or closing (T-033: offered after opening but not after closing).
    ...gs.filter((g) => g.offerNext?.length).map((g) => `  Whenever you open or close ${g.name} and the caller hasn't mentioned `
      + `${g.offerNext.map(name).join(' or ')}, ask whether to do ${g.offerNext.length > 1 ? 'those' : 'that'} as well.`),
    '  "All of them" or "everything" means every group. Confirm plainly what you\'ve done ("The living room blinds are',
    '  closing now."). If something didn\'t respond or a battery is low, say so simply.',
  ];
  return lines.join('\n');
}

async function moveBlinds({ groups: ids = [], action }) {
  const results = await Promise.all(ids.flatMap((g) => (group(g)?.devices ?? []).map(async (d) => {
    const cmd = COMMANDS[d.kind][action];
    if (!cmd) return { device: d.name, error: `${d.kind}s can't go "${action}"` };
    try { await sendCommand(d.id, ...cmd); return { device: d.name, ok: true }; } catch (err) { return { device: d.name, error: err.message }; }
  })));
  if (!results.length) return { error: 'No such blinds.' };
  const failed = results.filter((r) => r.error);
  return {
    moving: ids.map((g) => group(g)?.name).filter(Boolean), action,
    ...(failed.length ? { did_not_respond: failed } : {}),
  };
}

const describe = (kind, s) => {
  if (kind === 'curtain') return s.slidePosition <= 5 ? 'open' : s.slidePosition >= 95 ? 'closed' : `${s.slidePosition}% closed`;
  // Blind Tilt: about 50 = slats level (open); toward 0 or 100 = tilted shut.
  const off = Math.abs(s.slidePosition - 50);
  return off <= 10 ? 'open' : off >= 35 ? 'closed' : 'part open';
};
async function blindsStatus() {
  const out = {};
  await Promise.all(groups().flatMap((g) => g.devices.map(async (d) => {
    try {
      const s = await deviceStatus(d.id);
      out[d.name] = describe(d.kind, s) + (s.battery < LOW_BATTERY ? ` (battery low, ${s.battery}%)` : '');
    } catch (err) { out[d.name] = `not answering (${err.message})`; }
  })));
  return out;
}

export const homeHandlers = { move_blinds: moveBlinds, blinds_status: blindsStatus };
// The home controls in a few words, for describing the exchange ('' if none are set up): the blinds and curtains
// from the settings, plus the lights while the home bridge has some (D-48).
export const homeControlsSummary = () => {
  const kinds = [...new Set(groups().flatMap((g) => g.devices.map((d) => d.kind)))].map((k) => `${k}s`);
  if (lightsSummary()) kinds.push('lights');
  if (houseThermostats().length) kinds.push('thermostats');
  return kinds.length ? `the household's ${kinds.join(' and ')}` : '';
};
// Everything Doris and the porter know about the home controls ('' if none).
export const homeAllForPersona = () => [homeForPersona(), lightsForPersona(),
  houseForPersona().split('\n').filter((l) => l.startsWith('- Thermostats')).join('\n')].filter(Boolean).join('\n');

// Run on its own: lists the account's devices (read-only). With --draft, prints a starting "home" section for
// data/settings.json, one group per blind or curtain, to rename and combine (e.g. a pair of curtain motors).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { deviceList = [], infraredRemoteList = [] } = await listDevices();
  const kinds = { 'Blind Tilt': 'blind', Curtain: 'curtain', Curtain3: 'curtain' };
  if (process.argv.includes('--draft')) {
    const movable = deviceList.filter((d) => kinds[d.deviceType]);
    const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    console.log(JSON.stringify({ home: { provider: 'switchbot', layout: 'Describe the room(s) in a sentence.', groups: movable.map((d) => ({
      id: slug(d.deviceName), name: `the ${d.deviceName}`, where: 'where it is', callersSay: [`the ${d.deviceName.toLowerCase()}`],
      devices: [{ id: d.deviceId, name: d.deviceName, kind: kinds[d.deviceType] }] })) } }, null, 2));
  } else {
    for (const d of deviceList) console.log(`${d.deviceType.padEnd(16)} ${d.deviceName.padEnd(24)} ${d.deviceId}  cloud=${d.enableCloudService}`);
    if (infraredRemoteList.length) console.log(`(${infraredRemoteList.length} infrared remotes not shown)`);
  }
}
