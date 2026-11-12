// The house as Google Home knows it (D-51): rooms, lights, plugs and thermostats, by the names the household already
// uses there, read through the Home MCP server (googlehome.mjs) and worked with Matter's own commands (T-047).
// Kept as a cached map, refreshed every ten minutes and after connecting, so the tools stay quick and synchronous.
// Blinds and curtains stay with SwitchBot directly (its "close" direction was chosen with Martin, T-030), and the
// lock, doorbell, cameras and displays are never offered at all.
import { googleHomeConnected, callGoogleHome } from './googlehome.mjs';
import { household } from './home.mjs';

const REFRESH_MS = 10 * 60_000;
let house = null;  // { structureId, rooms: { id: name }, lights: [...], thermostats: [...] }
let refreshing = null;

const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const pct = (level) => (level == null ? null : Math.round(level / 2.54));
const validMireds = (m) => m >= 100 && m <= 1000; // 10,000 K to 1,000 K
const toKelvin = (mireds) => (mireds ? Math.round(1e6 / mireds / 100) * 100 : null);

// Which of the account's homes is this household's: the one with devices (Martin's account also lists an empty one).
async function pickStructure() {
  const { structures = [] } = await callGoogleHome('list_homes');
  for (const s of structures) {
    const r = await callGoogleHome('list_home_resources', { structureId: s.structureId, filter: { shortenedResourceTypes: ['GoogleLightDevice', 'ThermostatDevice', 'GooglePluginUnitDevice'] } });
    if ((r.resources ?? []).length) return { structureId: s.structureId, name: s.displayName };
  }
  return null;
}

export async function refreshHouse(log = console.log) {
  if (!googleHomeConnected()) { house = null; return null; }
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const where = house?.structureId ? { structureId: house.structureId, name: house.name } : await pickStructure();
      if (!where) { house = null; return null; }
      const { resources = [] } = await callGoogleHome('list_home_resources', { structureId: where.structureId });
      const rooms = Object.fromEntries(resources.filter((r) => r.type === 'Room').map((r) => [r.id, clean(r.displayName)]));
      const roomOf = (r) => (r.parentIds ?? []).map((p) => rooms[p]).find(Boolean) ?? null;
      const devices = resources.filter((r) => ['GoogleLightDevice', 'GooglePluginUnitDevice', 'ThermostatDevice'].includes(r.type));
      const ids = devices.map((d) => d.id);
      const { states = [] } = ids.length ? await callGoogleHome('list_home_states', { structureId: where.structureId, filter: { resourceIds: ids } }) : {};
      const stateOf = Object.fromEntries(states.map((s) => [s.id, s.traits ?? {}]));
      // A light's name must be unique: a generic one ("Lamp 1") used in two rooms gets its room in front.
      const named = devices.map((d) => ({ d, base: clean(d.displayName), room: roomOf(d) }));
      const clash = (n) => new Set(named.filter((x) => x.base.toLowerCase() === n.toLowerCase()).map((x) => x.room)).size > 1;
      const lights = []; const thermostats = [];
      for (const { d, base, room } of named) {
        const tr = stateOf[d.id] ?? {};
        const name = clash(base) && room ? `${room} ${base}` : base;
        if (d.type === 'ThermostatDevice') {
          thermostats.push({ name, room, id: d.id, type: d.type });
          continue;
        }
        const t = new Set(d.supportedTraits ?? []);
        const cc = tr.ColorControl?.state ?? {};
        const existing = lights.find((l) => l.name.toLowerCase() === name.toLowerCase());
        if (existing) { existing.ids.push({ id: d.id, type: d.type }); continue; } // a device listed twice is worked as one
        lights.push({
          name, room, ids: [{ id: d.id, type: d.type }],
          can: { dim: t.has('LevelControl'), color: t.has('ColorControl'), white: t.has('ColorControl'),
            // Some bulbs report no usable white range while in colour mode (T-047): then the usual 2,000-6,500 K.
            ...(validMireds(cc.colorTempPhysicalMaxMireds) && validMireds(cc.colorTempPhysicalMinMireds)
              ? { warmest_kelvin: toKelvin(cc.colorTempPhysicalMaxMireds), coolest_kelvin: toKelvin(cc.colorTempPhysicalMinMireds) }
              : t.has('ColorControl') ? { warmest_kelvin: 2000, coolest_kelvin: 6500 } : {}) },
          state: lightState(tr),
        });
      }
      // Everything else in the home, for the settings page: what it is and what the phone does with it.
      const KIND = { WindowCoveringDevice: 'blind or curtain', DoorLockDevice: 'lock', GoogleDoorbellDevice: 'doorbell', SpeakerDevice: 'speaker',
        GoogleDisplayDevice: 'display', ControlBridgeDevice: 'hub', GoogleGenericSensorDevice: 'sensor', GoogleCameraDevice: 'camera' };
      const others = resources.filter((r) => !['Structure', 'Room'].includes(r.type) && !devices.includes(r))
        .map((r) => ({ name: clean(r.displayName), room: roomOf(r), kind: KIND[r.type] ?? 'device',
          use: r.type === 'WindowCoveringDevice' ? 'worked through SwitchBot' : r.type === 'DoorLockDevice' ? 'never used by the phone' : 'not used by the phone' }));
      house = { ...where, rooms, lights, thermostats, others, at: Date.now() };
      log(`Google Home: ${where.name}, ${lights.length} lights, ${thermostats.length} thermostats in ${new Set(lights.map((l) => l.room)).size} rooms`);
      return house;
    } catch (err) { log(`Google Home could not be read: ${err.message}`); return house; } finally { refreshing = null; }
  })();
  return refreshing;
}
export function startHouse(log) { refreshHouse(log); setInterval(() => refreshHouse(log), REFRESH_MS); }
export const houseLights = () => house?.lights ?? [];
export const houseThermostats = () => house?.thermostats ?? [];
// The whole home for the settings page, room by room.
export function houseOverview() {
  if (!house) return null;
  const rows = [
    ...house.lights.map((l) => ({ name: l.name, room: l.room, kind: l.can.dim ? 'light' : 'switch',
      use: [l.can.dim ? 'on, off, dim' : 'on, off', l.can.color ? 'colour' : '', l.can.white ? 'warm to cool white' : ''].filter(Boolean).join(', ') })),
    ...house.thermostats.map((t) => ({ name: t.name, room: t.room, kind: 'thermostat', use: 'reading only' })),
    ...house.others,
  ];
  const rooms = {};
  for (const r of rows) (rooms[r.room ?? 'No room'] ??= []).push({ name: r.name, kind: r.kind, use: r.use });
  return { home: house.name, read_at: house.at, rooms: Object.entries(rooms).map(([name, devices]) => ({ name, devices })) };
}
export const houseReady = () => Boolean(house?.lights?.length || house?.thermostats?.length);

function lightState(tr) {
  const on = tr.OnOff?.state?.onOff ?? null;
  const level = tr.Brightness?.state?.currentBrightnessPercent ?? pct(tr.LevelControl?.state?.currentLevel);
  const cc = tr.ColorControl?.state;
  let color = null;
  if (cc?.colorMode === 'COLOR_MODE_ENUM_COLOR_TEMPERATURE_MIREDS' || cc?.colorMode === 2) color = { white_kelvin: toKelvin(cc.colorTemperatureMireds) };
  else if (cc?.colorMode === 'COLOR_MODE_ENUM_CURRENT_HUE_AND_CURRENT_SATURATION' || cc?.colorMode === 0) color = { hue: Math.round(cc.currentHue * 360 / 254), saturation: pct(cc.currentSaturation) };
  return { on, level, ...(color ? { color } : {}) };
}

const run = (requests) => callGoogleHome('run_home_actions', { structureId: house.structureId, homeActionRequests: requests });
const OPTS = { transitionTime: 5, optionsMask: 0, optionsOverride: 0 };

// The lights tool's work, with Google Home behind it. names: light names or room names (every light in it).
export async function houseSwitchLights({ lights: names = [], action, level, hue, saturation, kelvin }) {
  const wanted = new Set(names.map((n) => clean(n).toLowerCase()));
  const targets = houseLights().filter((l) => wanted.has(l.name.toLowerCase()) || (l.room && wanted.has(l.room.toLowerCase())));
  if (!targets.length) return { error: `No light or room called ${names.join(', ')}.` };
  const command = (l) => {
    if (action === 'on') return ['OnOff.On'];
    if (action === 'off') return ['OnOff.Off'];
    if (action === 'dim') return l.can.dim && ['LevelControl.MoveToLevelWithOnOff', { level: Math.round(Math.max(1, Math.min(100, Number(level) || 50)) * 2.54), ...OPTS }];
    if (action === 'color') return l.can.color && ['ColorControl.MoveToHueAndSaturation', { hue: Math.round(((((Number(hue) || 0) % 360) + 360) % 360) * 254 / 360), saturation: Math.round(Math.max(0, Math.min(100, Number(saturation ?? 100))) * 2.54), ...OPTS }];
    if (action === 'white') { const k = Math.max(l.can.warmest_kelvin ?? 2000, Math.min(l.can.coolest_kelvin ?? 6500, Number(kelvin) || 2700)); return l.can.white && ['ColorControl.MoveToColorTemperature', { colorTemperatureMireds: Math.round(1e6 / k), ...OPTS }]; }
    if (action === 'status') return null;
    return false;
  };
  if (action === 'status') return houseLightsStatus(targets);
  const requests = []; const out = [];
  for (const l of targets) {
    const c = command(l);
    if (!c) { out.push({ name: l.name, error: `can't ${action === 'color' ? 'change colour' : action === 'white' ? 'change its white' : action === 'dim' ? 'be dimmed' : action}` }); continue; }
    // Colour and white on a light that is off: switch it on first, as the bridge does.
    if ((action === 'color' || action === 'white') && l.state.on === false) for (const x of l.ids) requests.push({ ...x, command: 'OnOff.On' });
    for (const x of l.ids) requests.push({ ...x, command: c[0], ...(c[1] ? { parameters: c[1] } : {}) });
    out.push(l);
  }
  const answer = requests.length ? await run(requests) : { homeActionResponses: [] };
  const failed = new Set((answer.homeActionResponses ?? []).filter((r) => r.error).map((r) => r.id));
  return out.map((l) => {
    if (l.error) return l;
    if (l.ids.every((x) => failed.has(x.id))) return { name: l.name, error: 'did not answer' };
    // An accepted command is taken as done (as with the bridge, T-043); the next refresh reads the real state.
    if (action === 'on') l.state.on = true;
    if (action === 'off') l.state.on = false;
    if (action === 'dim') { l.state.on = true; l.state.level = Math.max(1, Math.min(100, Number(level) || 50)); }
    if (action === 'color') { l.state.on = true; l.state.color = { hue: Number(hue) || 0, saturation: Number(saturation ?? 100) }; }
    if (action === 'white') { l.state.on = true; l.state.color = { white_kelvin: Number(kelvin) || 2700 }; }
    return { name: l.name, ...l.state };
  });
}

export async function houseLightsStatus(only = houseLights()) {
  const ids = only.flatMap((l) => l.ids.map((x) => x.id));
  const { states = [] } = await callGoogleHome('list_home_states', { structureId: house.structureId, filter: { resourceIds: ids } });
  const byId = Object.fromEntries(states.map((s) => [s.id, s]));
  return only.map((l) => {
    const s = byId[l.ids[0].id];
    if (!s || s.resourceConnectivityState === 'OFFLINE') return { name: l.name, error: 'not answering' };
    l.state = lightState(s.traits ?? {});
    return { name: l.name, room: l.room, ...l.state };
  });
}

// --- Thermostats: read, and move the set temperature (never the mode). Temperatures in the household's unit.
const unit = () => household().units.temperature; // 'fahrenheit' | 'celsius'
const fromC = (c) => (c == null ? null : Math.round(unit() === 'fahrenheit' ? c * 9 / 5 + 32 : c));
const toC = (t) => (unit() === 'fahrenheit' ? (t - 32) * 5 / 9 : t);
const MODE = { SYSTEM_MODE_ENUM_HEAT: 'heat', SYSTEM_MODE_ENUM_COOL: 'cool', SYSTEM_MODE_ENUM_AUTO: 'auto', SYSTEM_MODE_ENUM_OFF: 'off' };
async function readThermostats(only = houseThermostats()) {
  const { states = [] } = await callGoogleHome('list_home_states', { structureId: house.structureId, filter: { resourceIds: only.map((t) => t.id) } });
  return only.map((t) => {
    const s = states.find((x) => x.id === t.id); const th = s?.traits?.Thermostat?.state;
    if (!th) return { name: t.name, error: 'not answering' };
    const mode = MODE[th.systemMode] ?? 'unknown';
    return { name: t.name, room: t.room, mode, now: fromC(th.localTemperature), heat_to: fromC(th.occupiedHeatingSetpoint), cool_to: fromC(th.occupiedCoolingSetpoint),
      humidity: s.traits.RelativeHumidityMeasurement?.state?.measuredValue ?? null, unit: unit(), _c: th };
  });
}
export async function thermostatStatus() { return { thermostats: (await readThermostats()).map(({ _c, ...t }) => t) }; }
export async function setThermostat({ thermostat, temperature, change }) {
  const t = houseThermostats().find((x) => x.name.toLowerCase() === clean(thermostat).toLowerCase() || x.room?.toLowerCase() === clean(thermostat).toLowerCase());
  if (!t) return { error: `No thermostat called "${thermostat}". Thermostats: ${houseThermostats().map((x) => x.name).join(', ')}.` };
  const [now] = await readThermostats([t]);
  if (now.error) return now;
  if (now.mode === 'off') return { error: `${t.name} is switched off; turning it on or changing its mode is done in Google Home.` };
  // The set point that matters in this mode; auto moves both.
  const current = now.mode === 'heat' ? now._c.occupiedHeatingSetpoint : now._c.occupiedCoolingSetpoint;
  const targetC = temperature != null ? toC(Number(temperature)) : current + (unit() === 'fahrenheit' ? Number(change) * 5 / 9 : Number(change));
  if (!Number.isFinite(targetC)) return { error: 'Give a temperature or a change.' };
  const amount = Math.max(-127, Math.min(127, Math.round((targetC - current) * 10))); // Matter steps of 0.1 °C
  const mode = now.mode === 'heat' ? 0 : now.mode === 'cool' ? 1 : 2;
  if (amount) await run([{ id: t.id, type: t.type, command: 'Thermostat.SetpointRaiseLower', parameters: { mode, amount } }]);
  return { name: t.name, mode: now.mode, now: now.now, set_to: fromC(current + amount / 10), unit: unit() };
}

// For the characters: the lights by room, and the thermostats ('' if none).
export function houseForPersona() {
  if (!houseReady()) return '';
  const byRoom = {};
  for (const l of houseLights()) (byRoom[l.room ?? 'Other'] ??= []).push(l.name);
  const lines = [`- The lights, by room (a room's name means every light in it): ${Object.entries(byRoom).map(([r, ls]) => `${r}: ${ls.join(', ')}`).join('; ')}.`];
  if (houseThermostats().length) lines.push(`- Thermostats: ${houseThermostats().map((t) => `${t.name}${t.room ? ` (${t.room})` : ''}`).join('; ')}. You can say what they read and `
    + `are set to${THERMOSTAT_CHANGES ? ' and change the temperature' : ', but not change them from this telephone yet: that is done in Google Home'}.`);
  return lines.join('\n');
}

// Tools for the thermostats (offered only when Google Home has some).
// Reading only, for now (T-047): through Google, SetpointRaiseLower moves in whole degrees Celsius, not the tenths
// Matter specifies, so a "one degree warmer" sent the living room to 82 °F. Changing temperatures stays off until a
// precise way is found and tested; setThermostat is kept but not offered.
const THERMOSTAT_CHANGES = false;
export function thermostatTools() {
  const ts = houseThermostats();
  if (!ts.length) return [];
  const names = [...ts.map((t) => t.name)];
  return [
    { name: 'thermostat_status', description: `What each thermostat reads and is set to, and whether it's heating, cooling, on auto or off. Thermostats: ${names.join('; ')}.`,
      input_schema: { type: 'object', properties: {} } },
    ...(THERMOSTAT_CHANGES ? [{ name: 'set_thermostat', description: 'Set a thermostat\'s temperature, or move it up or down. Never changes heat, cool or off. '
        + `Temperatures in ${unit() === 'fahrenheit' ? 'Fahrenheit' : 'Celsius'}. Confirm it to the caller once this succeeds.`,
      input_schema: { type: 'object', properties: {
        thermostat: { type: 'string', enum: names, description: 'Which thermostat.' },
        temperature: { type: 'number', description: 'The temperature to set, e.g. 70.' },
        change: { type: 'number', description: 'Or a change instead, e.g. 2 for two degrees warmer, -1 for one cooler.' },
      }, required: ['thermostat'] } }] : []),
  ];
}
export const thermostatHandlers = { thermostat_status: thermostatStatus, ...(THERMOSTAT_CHANGES ? { set_thermostat: setThermostat } : {}) };
