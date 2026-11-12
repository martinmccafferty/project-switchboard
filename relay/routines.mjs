// Routines (D-49): the house porter's own job (Q-17). A routine is a named set of steps over the household's
// controls (blinds and curtains through SwitchBot, lights through the home bridge), run when asked ("goodnight")
// and, if it has a schedule, by itself at a set time on set days ("lights off at eleven every night").
// The porter sets them up by conversation; Doris can run and list them. Stored in data/routines.json
// (git-ignored; on Railway the volume), apart from the settings so a settings save never overwrites them.
import fs from 'node:fs';
import path from 'node:path';
import { household } from './home.mjs';
import { homeHandlers } from './switchbot.mjs';
import { lightsHandlers, lightNames } from './lights.mjs';
import { settings } from './settings.mjs';

const FILE = process.env.ROUTINES_FILE || 'data/routines.json';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

let routines = [];
try { routines = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* none yet */ }
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(routines, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE); // atomic: a crash never leaves half a file
}
export const allRoutines = () => routines;
const find = (name) => routines.find((r) => r.name.toLowerCase() === String(name ?? '').trim().toLowerCase());
const blindGroups = () => (settings().home?.groups ?? []).map((g) => g.id);

// "23:00 every day", "07:00 on weekdays", "08:30 on Sat, Sun": for speaking and the settings page.
export function describeSchedule(s) {
  if (!s) return 'when asked';
  const d = s.days ?? DAYS;
  const days = d.length === 7 ? 'every day' : d.join() === 'mon,tue,wed,thu,fri' ? 'on weekdays'
    : d.join() === 'sun,sat' || d.join() === 'sat,sun' ? 'at weekends' : `on ${d.map((x) => x[0].toUpperCase() + x.slice(1)).join(', ')}`;
  return `${s.time} ${days}`;
}

// Runs a routine's steps in order, so two steps on one light can't race (T-045). Returns what each step did.
async function runSteps(steps) {
  const out = [];
  for (const st of steps) out.push(await (async () => {
    try {
      if (st.device === 'blinds') return { step: `blinds ${st.targets.join(', ')} ${st.action}`, ...(await homeHandlers.move_blinds({ groups: st.targets, action: st.action })) };
      const r = await lightsHandlers.switch_lights({ lights: st.targets, action: st.action, level: st.level, hue: st.hue, saturation: st.saturation, kelvin: st.kelvin });
      return { step: `lights ${st.targets.join(', ')} ${st.action}`, ...r };
    } catch (err) { return { step: `${st.device} ${st.targets.join(', ')}`, error: err.message }; }
  })());
  return out;
}

// --- Tools. The porter gets all four; Doris gets run_routine and list_routines.
const stepSchema = {
  type: 'object',
  properties: {
    device: { type: 'string', enum: ['lights', 'blinds'] },
    targets: { type: 'array', items: { type: 'string' }, description: 'Light names, or blind group ids, exactly as your tools name them.' },
    action: { type: 'string', enum: ['on', 'off', 'dim', 'color', 'white', 'open', 'close', 'half'],
      description: 'Lights: on, off, dim, color, white (dim, color and white switch a light on by themselves: no separate "on" step). '
        + 'Blinds: open, close, half (half for curtains only).' },
    level: { type: 'integer', minimum: 1, maximum: 100 },
    hue: { type: 'integer', minimum: 0, maximum: 359 },
    saturation: { type: 'integer', minimum: 0, maximum: 100 },
    kelvin: { type: 'integer', minimum: 2000, maximum: 7000 },
  },
  required: ['device', 'targets', 'action'],
};
export const routineTools = () => [
  {
    name: 'save_routine',
    description: 'Create a routine, or replace one with the same name: a set of steps over the lights and blinds, run when '
      + 'asked and, if given a schedule, by itself. Only save once the caller has agreed what it does and when.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What the household calls it, e.g. "goodnight" or "cosy evening".' },
        steps: { type: 'array', items: stepSchema, minItems: 1 },
        schedule: {
          type: 'object', description: 'Omit for a routine that runs only when asked.',
          properties: {
            time: { type: 'string', description: 'Home local time, 24-hour "HH:MM", e.g. "23:00".' },
            days: { type: 'array', items: { type: 'string', enum: DAYS }, description: 'Omit for every day.' },
          },
          required: ['time'],
        },
      },
      required: ['name', 'steps'],
    },
  },
  { name: 'run_routine', description: 'Run a routine now.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'list_routines', description: "The household's routines: what each does and when it runs.", input_schema: { type: 'object', properties: {} } },
  { name: 'delete_routine', description: 'Remove a routine (and its schedule).', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
];

function saveRoutine({ name, steps = [], schedule }) {
  const n = String(name ?? '').trim();
  if (!n) return { error: 'A routine needs a name.' };
  const lights = new Set(lightNames()); // checked against what exists now, so a typo can't be saved
  const groups = blindGroups();
  for (const st of steps) {
    if (st.device === 'blinds') { const bad = st.targets.find((t) => !groups.includes(t)); if (bad) return { error: `No blind group "${bad}". Groups: ${groups.join(', ')}.` }; }
    if (st.device === 'lights' && lights.size) { const bad = st.targets.find((t) => !lights.has(t)); if (bad) return { error: `No light "${bad}". Lights: ${[...lights].join(', ')}.` }; }
  }
  if (schedule && !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time ?? '')) return { error: 'The time must be "HH:MM", 24-hour.' };
  const was = find(n);
  const r = { name: n, steps, ...(schedule ? { schedule: { time: schedule.time, ...(schedule.days?.length && schedule.days.length < 7 ? { days: schedule.days } : {}) } } : {}),
    created: was?.created ?? Date.now() };
  routines = routines.filter((x) => x !== was).concat(r); save();
  return { saved: n, replaced: !!was, runs: describeSchedule(r.schedule) };
}
async function runRoutine({ name }) {
  const r = find(name);
  if (!r) return { error: `No routine called "${name}". Routines: ${routines.map((x) => x.name).join(', ') || 'none yet'}.` };
  return { ran: r.name, results: await runSteps(r.steps) };
}
const listRoutines = () => ({ routines: routines.map((r) => ({ name: r.name, runs: describeSchedule(r.schedule), steps: r.steps,
  ...(r.lastRun ? { last_ran: new Date(r.lastRun.at).toLocaleString('en-US', { timeZone: household().timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' }), ...(r.lastRun.problems ? { last_problems: r.lastRun.problems } : {}) } : {}) })) });
export function deleteRoutine({ name }) {
  const r = find(name);
  if (!r) return { error: `No routine called "${name}".` };
  routines = routines.filter((x) => x !== r); save();
  return { deleted: r.name };
}
export const routineHandlers = { save_routine: saveRoutine, run_routine: runRoutine, list_routines: listRoutines, delete_routine: deleteRoutine };

// For the characters' personas ('' if none).
export const routinesForPersona = () => (routines.length
  ? `- The household's routines: ${routines.map((r) => `"${r.name}" (${describeSchedule(r.schedule)})`).join('; ')}.`
  : '');

// --- The schedule: checked every 20 s; each scheduled routine runs once in its minute, in the home time zone.
// Runs missed while the relay was down are not made up later (a "lights off at eleven" at half past one would surprise).
function homeNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: household().timezone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { minute: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`, time: `${p.hour}:${p.minute}`, day: p.weekday.slice(0, 3).toLowerCase() };
}
export function startSchedule(log = console.log) {
  setInterval(async () => {
    const now = homeNow();
    for (const r of routines) {
      const s = r.schedule;
      if (!s || s.time !== now.time || !(s.days ?? DAYS).includes(now.day) || r.lastRun?.minute === now.minute) continue;
      r.lastRun = { minute: now.minute, at: Date.now() }; save();
      const results = await runSteps(r.steps);
      const problems = results.filter((x) => x.error || x.did_not_respond || x.lights?.some?.((l) => /not answering/.test(l))).map((x) => x.step);
      if (problems.length) { r.lastRun.problems = problems; save(); }
      log(`Routine "${r.name}" ran on schedule${problems.length ? `; problems: ${problems.join('; ')}` : ''}`);
    }
  }, 20_000);
}
