// Reminders (M4): Doris sets them; the exchange rings the phone when one is due and Doris delivers it.
// Stored durably in data/reminders.json (git-ignored; on Railway this needs a persistent volume).
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.REMINDERS_FILE || 'data/reminders.json';
import { household } from './home.mjs';
const RETRY_MS = Number(process.env.REMINDER_RETRY_MS) || 5 * 60 * 1000; // unanswered: try again after 5 minutes...
const MAX_ATTEMPTS = 3;           // ...up to 3 rings in all, then it's "missed" and Doris mentions it next call

// status: pending -> delivered | missed -> mentioned; or cancelled
let reminders = [];
try { reminders = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* none yet */ }
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(reminders, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE); // atomic: a crash never leaves half a file
}

// --- Home-time helpers (no libraries): "2026-11-08T17:00" in the home time zone <-> an instant.
function zoneOffsetMs(utcMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: household().timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, Number(p.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs;
}
function homeTimeToInstant(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return NaN;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const first = asUtc - zoneOffsetMs(asUtc);
  return asUtc - zoneOffsetMs(first); // second pass gets daylight-saving changeovers right
}
export const sayWhen = (ms) => new Date(ms).toLocaleString('en-US', {
  timeZone: household().timezone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

// --- Tools for Doris.
export const reminderTools = [
  {
    name: 'set_reminder',
    description: 'Set a reminder. When it is due, the switchboard rings the phone and you deliver it. Give either '
      + 'in_minutes (for "in twenty minutes") or at (home local time, for "at five o\'clock"; check the time first '
      + 'if you need today\'s date).',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to remind them of, in a few words, e.g. "take the bread out".' },
        in_minutes: { type: 'number', description: 'Minutes from now.' },
        at: { type: 'string', description: 'Home local date and time, "YYYY-MM-DDTHH:MM" (24-hour).' },
      },
      required: ['message'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List reminders that are still to come.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a reminder by its id (from list_reminders).',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

function setReminder({ message, in_minutes: inMinutes, at }) {
  if (!message?.trim()) return { error: 'A reminder needs something to remind them of.' };
  const now = Date.now();
  const due = typeof inMinutes === 'number' ? now + inMinutes * 60000 : homeTimeToInstant(at ?? '');
  if (!Number.isFinite(due)) return { error: 'Give in_minutes or at as "YYYY-MM-DDTHH:MM".' };
  if (due < now + 30000) return { error: 'That time has already passed (or is under a minute away).' };
  if (due > now + 60 * 86400000) return { error: 'Reminders can be set up to sixty days ahead.' };
  const id = `r${(reminders.reduce((max, r) => Math.max(max, Number(r.id.slice(1)) || 0), 0) + 1)}`;
  reminders.push({ id, message: message.trim(), dueAt: due, createdAt: now, status: 'pending', attempts: 0, nextAttemptAt: due });
  save();
  return { id, message: message.trim(), will_ring_at: sayWhen(due) };
}

function listReminders() {
  const upcoming = reminders.filter((r) => r.status === 'pending').sort((a, b) => a.dueAt - b.dueAt);
  return { reminders: upcoming.map((r) => ({ id: r.id, message: r.message, rings_at: sayWhen(r.dueAt) })) };
}

function cancelReminder({ id }) {
  const r = reminders.find((x) => x.id === id && x.status === 'pending');
  if (!r) return { error: `No upcoming reminder with id ${id}.` };
  r.status = 'cancelled'; save();
  return { cancelled: r.message };
}

export const reminderHandlers = { set_reminder: setReminder, list_reminders: listReminders, cancel_reminder: cancelReminder };

// --- For the exchange's scheduler.
export const dueReminders = (now = Date.now()) => reminders.filter((r) => r.status === 'pending' && r.nextAttemptAt <= now);
export function markDelivered(id) { const r = reminders.find((x) => x.id === id); if (r) { r.status = 'delivered'; r.deliveredAt = Date.now(); save(); } }
// An unanswered ring: try again later, or give up and keep it for Doris to mention.
export function markUnanswered(id) {
  const r = reminders.find((x) => x.id === id); if (!r) return;
  r.attempts++;
  if (r.attempts >= MAX_ATTEMPTS) r.status = 'missed'; else r.nextAttemptAt = Date.now() + RETRY_MS;
  save();
}
// Missed reminders not yet mentioned, marked as mentioned (Doris brings them up on the next call to 0).
export function takeMissed() {
  const missed = reminders.filter((r) => r.status === 'missed');
  for (const r of missed) r.status = 'mentioned';
  if (missed.length) save();
  return missed.map((r) => ({ message: r.message, was_due: sayWhen(r.dueAt) }));
}
