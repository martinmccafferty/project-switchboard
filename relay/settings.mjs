// The household's settings (D-35, D-37, D-38): everything about one home lives here, not in the code, so another
// household can run the same relay. Stored by the relay in data/settings.json (git-ignored; on Railway, a
// persistent volume) and read live: an edit applies to the next call without a restart. The settings page (D-37)
// will change them through update(). Secrets (API keys, the SwitchBot token) stay in .env.
// Shape: see settings.example.json.
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.SETTINGS_FILE || 'data/settings.json';

// First start: begin from what .env says (so an existing setup carries on unchanged), with no rooms yet.
function fromEnv() {
  return {
    household: {
      location: (process.env.HOME_LOCATION || process.env.HOME_LOCATION_NAME || '').trim(),
      timezone: process.env.HOME_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
      temperatureUnit: /^c/i.test(process.env.TEMPERATURE_UNIT || '') ? 'celsius' : 'fahrenheit',
      transcribeKeywords: (process.env.TRANSCRIBE_KEYWORDS || '').split(',').map((k) => k.trim()).filter(Boolean),
    },
    home: { provider: 'switchbot', groups: [] },
  };
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(`${FILE}.tmp`, FILE); // atomic: a crash never leaves half a file
}

let current = null; let loadedMtime = 0;
// The settings now. Re-reads the file when it has changed on disk, so a hand edit applies at once.
export function settings() {
  try {
    const { mtimeMs } = fs.statSync(FILE);
    if (!current || mtimeMs !== loadedMtime) {
      current = JSON.parse(fs.readFileSync(FILE, 'utf8')); loadedMtime = mtimeMs;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') { console.log(`Settings file unreadable (${err.message}); keeping the last good settings`); return current ?? fromEnv(); }
    current = fromEnv(); save(current); loadedMtime = fs.statSync(FILE).mtimeMs;
    console.log(`Settings: created ${FILE} from .env`);
  }
  return current;
}

// Merges a change into one section ({ household: { temperatureUnit: 'celsius' } }) and saves it.
export function updateSettings(change) {
  const next = structuredClone(settings());
  for (const [section, values] of Object.entries(change)) next[section] = { ...next[section], ...values };
  save(next); current = next; loadedMtime = fs.statSync(FILE).mtimeMs;
  return next;
}
