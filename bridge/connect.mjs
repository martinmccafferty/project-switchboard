// The home bridge, running (D-48, step 2): keeps the joined lights connected over Matter, connects out to the relay
// (RELAY_URL, BRIDGE_TOKEN in .env), tells it which lights there are and how they stand, and switches them when
// Doris or the porter asks: on, off, dim, and on lights that have them, colour and warm-to-cool white (T-044).
// Reconnects by itself if the relay or the network goes away.
//   npm start
import fs from 'node:fs';
import http from 'node:http';
import WebSocket from 'ws';
import { OnOff, LevelControl, ColorControl } from '@matter/main/clusters';
import { openController, device, pair } from './matter.mjs';

const URL_ = process.env.RELAY_URL; const TOKEN = process.env.BRIDGE_TOKEN;
if (!URL_ || !TOKEN) { console.log('Set RELAY_URL and BRIDGE_TOKEN in bridge/.env'); process.exit(1); }
const now = () => new Date().toLocaleTimeString();
const FADE_TENTHS = 5; // a half-second fade when dimming
const pct = (level) => (level == null ? null : Math.round(level / 2.54));
const NO_OPTIONS = { optionsMask: {}, optionsOverride: {} };
// Matter's colour units: hue and saturation 0-254, white as mireds (a million divided by kelvin).
const toKelvin = (mireds) => Math.round(1e6 / mireds / 100) * 100;
// The colour as the operator should hear it: { hue, saturation } in degrees and percent, or { white_kelvin }.
async function readColor(cc) {
  const mode = await cc.getColorModeAttribute(true); // 0 hue and saturation, 1 xy, 2 white
  if (mode === 2) return { white_kelvin: toKelvin(await cc.getColorTemperatureMiredsAttribute(true)) };
  if (mode === 0) return { hue: Math.round((await cc.getCurrentHueAttribute(true)) * 360 / 254), saturation: pct(await cc.getCurrentSaturationAttribute(true)) };
  return { color: 'set from another app' };
}

// One bridge per machine: a second copy would share the Matter identity and fight the first for the relay.
const LOCK = new URL('./data/bridge.pid', import.meta.url).pathname;
try {
  const other = Number(fs.readFileSync(LOCK, 'utf8'));
  if (other && other !== process.pid) { process.kill(other, 0); console.log(`The bridge is already running (process ${other}).`); process.exit(1); }
} catch { /* no lock, or its process has gone */ }
fs.writeFileSync(LOCK, String(process.pid));
process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch { /* gone */ } });

// --- The lights, kept connected. name -> { onOff, level, color, caps, state: { on, level, color } }
const controller = await openController();
const lamps = new Map();
async function addLamp(id) {
  try {
    const { node, name } = await device(controller, String(id));
    const d = node.getDevices().find((x) => x.getClusterClient(OnOff.Complete));
    if (!d) return;
    const lamp = { onOff: d.getClusterClient(OnOff.Complete), level: d.getClusterClient(LevelControl.Complete),
      color: d.getClusterClient(ColorControl.Complete), caps: {}, state: {} };
    if (lamp.color) {
      const f = await lamp.color.getFeatureMapAttribute();
      lamp.caps = { color: !!f.hueSaturation, white: !!f.colorTemperature };
      if (f.colorTemperature) {
        lamp.caps.warmest_kelvin = toKelvin(await lamp.color.getColorTempPhysicalMaxMiredsAttribute());
        lamp.caps.coolest_kelvin = toKelvin(await lamp.color.getColorTempPhysicalMinMiredsAttribute());
      }
      lamp.state.color = await readColor(lamp.color);
    }
    lamp.state.on = await lamp.onOff.getOnOffAttribute();
    lamp.state.level = lamp.level ? pct(await lamp.level.getCurrentLevelAttribute()) : null;
    lamp.onOff.addOnOffAttributeListener((v) => { lamp.state.on = v; changed(); });
    lamp.level?.addCurrentLevelAttributeListener((v) => { lamp.state.level = pct(v); changed(); });
    lamps.set(name, lamp);
    console.log(`[${now()}] ${name}: ${lamp.state.on ? 'on' : 'off'}`);
    return name;
  } catch (err) { console.log(`[${now()}] Light ${id} not answering: ${err.message}`); }
}
for (const id of controller.getCommissionedNodes()) await addLamp(id);

// Joining more lights while the bridge runs: \`npm run pair\` hands the code to this local-only door (the Matter
// identity is locked while the bridge runs, so pair.mjs can't use it itself). The new light is announced at once.
const LOCAL_PORT = Number(process.env.BRIDGE_LOCAL_PORT) || 8765;
http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/pair') { res.writeHead(404).end(); return; }
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const reply = (status, m) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(m)); };
    try {
      const { code, name } = JSON.parse(body);
      if ([...lamps.keys()].some((n) => n.toLowerCase() === String(name).trim().toLowerCase())) return reply(400, { error: `There is already a light called "${name}".` });
      console.log(`[${now()}] Joining "${name}"…`);
      const id = await pair(controller, code, name);
      const added = await addLamp(id);
      changed();
      reply(200, { nodeId: String(id), name: added ?? name });
    } catch (err) { reply(500, { error: err.message }); }
  });
}).listen(LOCAL_PORT, '127.0.0.1');
const report = (names = [...lamps.keys()]) => names.map((name) => {
  const l = lamps.get(name);
  return l ? { name, on: l.state.on, level: l.state.level, ...(l.state.color ? { color: l.state.color } : {}), can: l.caps } : { name, error: 'not joined to the bridge' };
});

async function run({ lights: names = [], action, level, hue, saturation, kelvin }) {
  const out = await Promise.all(names.map(async (name) => {
    const l = lamps.get(name);
    if (!l) return { name, error: 'not joined to the bridge' };
    try {
      // An accepted command is taken as done: the bulbs report a new brightness only seconds later (T-043), so reading
      // it straight back showed the old level and sent Doris checking again and again. Their own reports follow.
      if (action === 'on') { await l.onOff.on(); l.state.on = true; }
      else if (action === 'off') { await l.onOff.off(); l.state.on = false; }
      else if (action === 'dim') {
        if (!l.level) return { name, error: "can't be dimmed" };
        const want = Math.max(1, Math.min(100, Number(level) || 50));
        await l.level.moveToLevelWithOnOff({ level: Math.round(want * 2.54), transitionTime: FADE_TENTHS, optionsMask: {}, optionsOverride: {} });
        l.state.on = true; l.state.level = want;
      } else if (action === 'color') {
        if (!l.caps.color) return { name, error: "can't change colour" };
        const h = ((Number(hue) % 360) + 360) % 360; const sat = Math.max(0, Math.min(100, Number(saturation ?? 100)));
        if (!l.state.on) await l.onOff.on();
        await l.color.moveToHueAndSaturation({ hue: Math.round(h * 254 / 360), saturation: Math.round(sat * 2.54), transitionTime: FADE_TENTHS, ...NO_OPTIONS });
        l.state.on = true; l.state.color = { hue: Math.round(h), saturation: Math.round(sat) };
      } else if (action === 'white') {
        if (!l.caps.white) return { name, error: "can't change its white" };
        const k = Math.max(l.caps.warmest_kelvin, Math.min(l.caps.coolest_kelvin, Number(kelvin) || 2700));
        if (!l.state.on) await l.onOff.on();
        await l.color.moveToColorTemperature({ colorTemperatureMireds: Math.round(1e6 / k), transitionTime: FADE_TENTHS, ...NO_OPTIONS });
        l.state.on = true; l.state.color = { white_kelvin: toKelvin(Math.round(1e6 / k)) };
      } else if (action === 'status') {
        l.state.on = await l.onOff.getOnOffAttribute(true);
        if (l.level) l.state.level = pct(await l.level.getCurrentLevelAttribute(true));
        if (l.color) l.state.color = await readColor(l.color);
      }
      return { name, on: l.state.on, level: l.state.level, ...(l.state.color ? { color: l.state.color } : {}) };
    } catch (err) { return { name, error: err.message }; }
  }));
  console.log(`[${now()}] ${action}${action === 'dim' ? ` ${level}%` : action === 'color' ? ` hue ${hue} sat ${saturation ?? 100}` : action === 'white' ? ` ${kelvin} K` : ''} ${names.join(', ')}: ${out.map((r) => r.error ? `${r.name} failed (${r.error})` : `${r.name} ${r.on ? 'on' : 'off'}`).join('; ')}`);
  return out;
}

// --- The connection to the relay, kept up.
let ws = null; let wait = 1000; let sendTimer = null;
function changed() { clearTimeout(sendTimer); sendTimer = setTimeout(() => send({ type: 'lights', lights: report() }), 300); }
const send = (m) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
function connect() {
  const me = new WebSocket(URL_, { headers: { authorization: `Bearer ${TOKEN}` } });
  ws = me;
  ws.on('open', () => { wait = 1000; console.log(`[${now()}] Connected to the relay (${new URL(URL_).host})`); send({ type: 'lights', lights: report() }); });
  ws.on('message', async (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.type !== 'command') return;
    const lights = await run(m);
    send({ type: 'result', id: m.id, ok: true, lights });
  });
  // An answer that isn't the connection (a 401, or a 502 while Railway restarts the relay): end this attempt so the
  // close handler tries again (T-049: without destroy() the attempt hung and the bridge never retried).
  ws.on('unexpected-response', (req, res) => {
    console.log(`[${now()}] The relay answered ${res.statusCode}${res.statusCode === 401 ? ': check BRIDGE_TOKEN' : ' (it may be restarting)'}`);
    req.destroy(); res.destroy();
    retry(); // the close event doesn't come for a refused handshake, so retry from here
  });
  ws.on('error', () => {}); // the close handler reconnects
  ws.on('close', (code) => {
    if (ws !== me) return; // an abandoned attempt; a newer one is already under way
    if (code === 4001) { console.log(`[${now()}] Another bridge has taken over; stopping this one`); process.exit(0); }
    retry();
  });
}
// One retry per failed attempt, however it failed, backing off from 1 s to 30 s.
let retrying = false;
function retry() {
  if (retrying) return;
  retrying = true;
  console.log(`[${now()}] Lost the relay; trying again in ${wait / 1000} s`);
  setTimeout(() => { retrying = false; connect(); }, wait); wait = Math.min(wait * 2, 30_000);
}
connect();
process.on('SIGINT', async () => { ws?.close(); await controller.close(); process.exit(0); });
