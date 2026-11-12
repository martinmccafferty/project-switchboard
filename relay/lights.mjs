// The lights (D-48, step 2), worked through the household's home bridge: a program at the house (the Mac for now,
// the phone's ESP32 later) that is a Matter controller on the home network, where the cloud can't reach. The bridge
// connects out to /bridge with BRIDGE_TOKEN, says which lights it has, and switches them when asked.
// Tools and persona lines exist only while a bridge with lights is connected, so nothing is promised that isn't there.
//   bridge -> relay  {"type":"lights","lights":[{"name":"office lamp","on":true,"level":80,"color":{"white_kelvin":2700},
//                     "can":{"color":true,"white":true,"warmest_kelvin":2000,"coolest_kelvin":7000}}]}   (on connect and on change)
//                    {"type":"result","id":7,"ok":true,"lights":[...]} | {"type":"result","id":7,"error":"..."}
//   relay -> bridge  {"type":"command","id":7,"lights":["office lamp"],"action":"on"|"off"|"dim"|"color"|"white"|"status",
//                     "level":30,"hue":240,"saturation":100,"kelvin":2700}   (colour and white only where "can" says so, T-044)
import crypto from 'node:crypto';

const TOKEN = process.env.BRIDGE_TOKEN || '';
const COMMAND_TIMEOUT_MS = 10_000;
let bridge = null;        // { ws, lights: [{ name, on, level }] }
let nextId = 1;
const waiting = new Map(); // id -> { resolve, timer }

// May this WebSocket connect to /bridge? Only with the bridge token.
export function bridgeAllowed(req) {
  if (!TOKEN) return false;
  const given = new URL(req.url, 'http://relay').searchParams.get('token') || (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const a = crypto.createHash('sha256').update(given).digest(); const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

export function attachBridge(ws, log = console.log) {
  // Newest wins; the old one is told why (4001), so it stops instead of reconnecting and taking turns.
  if (bridge) { log('Home bridge: a new connection replaces the old one'); try { bridge.ws.close(4001, 'replaced by another bridge'); } catch { /* gone */ } }
  const me = { ws, lights: [] }; bridge = me;
  log('Home bridge connected');
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (Array.isArray(m.lights)) me.lights = m.lights.filter((l) => typeof l?.name === 'string');
    if (m.type === 'lights') log(`Home bridge lights: ${me.lights.map((l) => `${l.name} ${l.on ? 'on' : 'off'}`).join(', ') || 'none'}`);
    if (m.type === 'result' && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); clearTimeout(w.timer); w.resolve(m); }
  });
  ws.on('close', () => { if (bridge === me) { bridge = null; log('Home bridge disconnected'); } });
  // Keeps the connection alive through proxies; a bridge that stops answering is dropped.
  let alive = true; ws.on('pong', () => { alive = true; });
  const ping = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, 30_000);
  ws.on('close', () => clearInterval(ping));
}

const lights = () => bridge?.lights ?? [];
function ask(command) {
  if (!bridge) return Promise.resolve({ error: "The house's light switchboard isn't connected just now." });
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: 'The lights did not answer in time.' }); }, COMMAND_TIMEOUT_MS);
    waiting.set(id, { resolve, timer });
    bridge.ws.send(JSON.stringify({ type: 'command', id, ...command }));
  });
}

export function lightsTools() {
  const ls = lights();
  if (!ls.length) return [];
  const colored = ls.filter((l) => l.can?.color).map((l) => l.name);
  const whites = ls.filter((l) => l.can?.white);
  const warmest = Math.min(...whites.map((l) => l.can.warmest_kelvin)); const coolest = Math.max(...whites.map((l) => l.can.coolest_kelvin));
  const actions = ['on', 'off', 'dim', ...(colored.length ? ['color'] : []), ...(whites.length ? ['white'] : [])];
  return [
    {
      name: 'switch_lights',
      description: `Turn the household's lights on or off, dim them${colored.length ? ', change their colour' : ''}${whites.length ? ', or set a warmer or cooler white' : ''}. `
        + `Lights: ${ls.map((l) => l.name).join('; ')}. `
        + (colored.length ? `Colour works on: ${colored.join('; ')}. ` : '')
        + (whites.length ? `White from ${warmest} K (warm, like candlelight) to ${coolest} K (cool daylight) works on: ${whites.map((l) => l.name).join('; ')}. ` : '')
        + 'Confirm it to the caller once this succeeds.',
      input_schema: {
        type: 'object',
        properties: {
          lights: { type: 'array', items: { type: 'string', enum: ls.map((l) => l.name) }, description: 'Which lights.' },
          action: { type: 'string', enum: actions },
          level: { type: 'integer', minimum: 1, maximum: 100, description: 'Brightness percent, for "dim" (e.g. 30 = low, 100 = full).' },
          ...(colored.length ? {
            hue: { type: 'integer', minimum: 0, maximum: 359, description: 'For "color": the hue in degrees. Red 0, orange 30, yellow 55, '
              + 'green 120, teal 170, cyan 185, blue 235, purple 275, magenta 300, pink 330.' },
            saturation: { type: 'integer', minimum: 0, maximum: 100, description: 'For "color": 100 = a strong colour, about 40 = a soft pastel.' },
          } : {}),
          ...(whites.length ? {
            kelvin: { type: 'integer', minimum: warmest, maximum: coolest, description: 'For "white": 2200 candlelight, 2700 warm white, '
              + '3500 soft white, 4000 neutral, 5000 daylight, 6500 cool daylight.' },
          } : {}),
        },
        required: ['lights', 'action'],
      },
    },
    {
      name: 'lights_status',
      description: 'Which lights are on or off, how bright, and their colour or white.',
      input_schema: { type: 'object', properties: {} },
    },
  ];
}

const colorWords = (c) => (!c ? '' : c.white_kelvin ? `, white at ${c.white_kelvin} K` : c.hue != null ? `, colour hue ${c.hue} saturation ${c.saturation}%` : `, colour ${c.color}`);
const shown = (r) => (r.error ? { error: r.error }
  : { lights: (r.lights ?? []).map((l) => `${l.name}: ${l.error ? `not answering (${l.error})` : l.on ? `on${l.level != null ? `, ${l.level}%` : ''}${colorWords(l.color)}` : 'off'}`) });
export const lightsHandlers = {
  switch_lights: async ({ lights: names = [], action, level, hue, saturation, kelvin }) => shown(await ask({ lights: names, action, level, hue, saturation, kelvin })),
  lights_status: async () => shown(await ask({ lights: lights().map((l) => l.name), action: 'status' })),
};

// What Doris and the porter know about the lights ('' if none).
export function lightsForPersona() {
  const ls = lights();
  if (!ls.length) return '';
  const colored = ls.some((l) => l.can?.color); const whites = ls.some((l) => l.can?.white);
  return `- The lights: ${ls.map((l) => l.name).join('; ')}. On, off and dim${colored ? ', any colour' : ''}${whites ? ', and white from warm to cool' : ''}. `
    + 'Speak of colours as a person would ("a soft blue", "a warm white"), never as numbers or kelvins. '
    + 'Confirm plainly what you\'ve done ("The office lamp is blue now."). If a light didn\'t answer, say so simply.';
}
export const lightsSummary = () => (lights().length ? "the household's lights" : '');
