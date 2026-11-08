// SwitchBot cloud API v1.1 (M4): the blinds and the curtain. Needs SWITCHBOT_TOKEN and SWITCHBOT_SECRET in .env.
// Run on its own to list the account's devices (read-only):  node --env-file=.env switchbot.mjs
import crypto from 'node:crypto';

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
export const sendCommand = (id, command, parameter = 'default') =>
  request('POST', `/devices/${id}/commands`, { command, parameter, commandType: 'command' });

// --- The house (Martin, T-022): one open-plan middle floor. Blind Tilt 1-3 across the front (left to right) are
// the living room; Blind Tilt 4 at the back is the dining area; the deck door beside it (kitchen side) has a
// pair of curtain motors that always move together.
const GROUPS = {
  living_room: { name: 'the living room blinds', devices: [
    { id: 'DD0716818010', name: 'left living room blind', kind: 'blind' },
    { id: 'E1B128B1DD53', name: 'middle living room blind', kind: 'blind' },
    { id: 'EA680B12616E', name: 'right living room blind', kind: 'blind' }] },
  dining_room: { name: 'the dining room blind', devices: [{ id: 'EF6240D23802', name: 'dining room blind', kind: 'blind' }] },
  deck_curtains: { name: 'the deck door curtains', devices: [
    { id: 'E44B2A6FCD05', name: 'deck door curtain (one half)', kind: 'curtain' },
    { id: 'F6A92DDF2447', name: 'deck door curtain (other half)', kind: 'curtain' }] },
};
const LOW_BATTERY = 15;

// Blind Tilt: closeDown tilts the slats shut (Martin: "exactly what I would expect"), fullyOpen levels them.
// Curtain: setPosition "index,mode,position" with position 0 = open, 100 = closed.
const COMMANDS = {
  blind: { open: ['fullyOpen'], close: ['closeDown'] },
  curtain: { open: ['setPosition', '0,ff,0'], close: ['setPosition', '0,ff,100'], half: ['setPosition', '0,ff,50'] },
};

export const homeTools = [
  {
    name: 'move_blinds',
    description: 'Open or close the blinds and curtains on the open-plan middle floor. Groups: living_room (three '
      + 'blinds across the front), dining_room (one blind at the back), deck_curtains (the pair of curtains on the '
      + 'deck door, kitchen side, next to the dining room blind). Blinds open or close; the curtains can also go '
      + 'half open. Takes a few seconds to move; confirm it to the caller once this succeeds.',
    input_schema: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: { type: 'string', enum: Object.keys(GROUPS) }, description: 'Which to move.' },
        action: { type: 'string', enum: ['open', 'close', 'half'], description: '"half" works only for deck_curtains.' },
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

async function moveBlinds({ groups = [], action }) {
  const results = await Promise.all(groups.flatMap((g) => (GROUPS[g]?.devices ?? []).map(async (d) => {
    const cmd = COMMANDS[d.kind][action];
    if (!cmd) return { device: d.name, error: `${d.kind}s can't go "${action}"` };
    try { await sendCommand(d.id, ...cmd); return { device: d.name, ok: true }; } catch (err) { return { device: d.name, error: err.message }; }
  })));
  if (!results.length) return { error: 'No such blinds.' };
  const failed = results.filter((r) => r.error);
  return {
    moving: groups.map((g) => GROUPS[g]?.name).filter(Boolean), action,
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
  await Promise.all(Object.values(GROUPS).flatMap((g) => g.devices.map(async (d) => {
    try {
      const s = await deviceStatus(d.id);
      out[d.name] = describe(d.kind, s) + (s.battery < LOW_BATTERY ? ` (battery low, ${s.battery}%)` : '');
    } catch (err) { out[d.name] = `not answering (${err.message})`; }
  })));
  return out;
}

export const homeHandlers = { move_blinds: moveBlinds, blinds_status: blindsStatus };

if (import.meta.url === `file://${process.argv[1]}`) {
  const { deviceList = [], infraredRemoteList = [] } = await listDevices();
  for (const d of deviceList) console.log(`${d.deviceType.padEnd(16)} ${d.deviceName.padEnd(24)} ${d.deviceId}  cloud=${d.enableCloudService}`);
  if (infraredRemoteList.length) console.log(`(${infraredRemoteList.length} infrared remotes not shown)`);
}
