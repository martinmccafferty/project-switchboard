// Where home is, and the household's units and words, from the settings (settings.mjs, read live), so nothing
// about one home is written into the code. The relay looks the place up itself (Open-Meteo geocoding, free, no
// key) from the location as a person would say it ("Morrisville, North Carolina").
import { settings } from './settings.mjs';

// The household now: { name, town, timezone, celsius, units, keywords }.
export function household() {
  const h = settings().household ?? {};
  const name = (h.location ?? '').trim(); const celsius = h.temperatureUnit === 'celsius';
  return {
    name, town: name.split(',')[0].trim(),
    timezone: h.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    celsius,
    units: celsius
      ? { temperature: 'celsius', wind: 'kmh', temperatureWord: 'Celsius', windWords: 'kilometers an hour' }
      : { temperature: 'fahrenheit', wind: 'mph', temperatureWord: 'Fahrenheit', windWords: 'miles an hour' },
    keywords: h.transcribeKeywords ?? [],
  };
}

const US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia' };

// "Portland, Oregon" / "Portland, OR" / "Glasgow in Scotland" / "Portland Oregon" / "Paris, France" / "Greenock"
// -> { name, latitude, longitude, timezone }, or null. The search takes a bare place name, so anything after it
// (a state, region or country) picks among the matches.
export async function geocode(query) {
  const said = query.trim().replace(/[.?!]+$/, '')
    .replace(/^(?:(?:the )?(?:weather|forecast) (?:for|in) |(?:for|in) )/i, '').replace(/,? please$/i, '');
  // "Glasgow in Scotland" means "Glasgow, Scotland".
  const parts = said.split(/\s*,\s*|\s+in\s+/i).filter(Boolean);
  if (!parts.length) return null;
  const found = await lookup(parts[0], parts.slice(1));
  if (found || parts.length > 1) return found;
  // No comma: "Portland Oregon" / "Glasgow Scotland": try the first words as the place and the rest as where.
  const words = parts[0].split(/\s+/);
  for (let k = words.length - 1; k >= 1; k--) {
    const hit = await lookup(words.slice(0, k).join(' '), [words.slice(k).join(' ')]);
    if (hit) return hit;
  }
  return null;
}

async function lookup(place, rest) {
  const want = rest.map((q) => (US_STATES[q.toUpperCase()] ?? q).toLowerCase());
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=10`,
    { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from the place lookup`);
  const hits = (await res.json()).results ?? [];
  const fits = (h) => want.every((q) => [h.admin1, h.admin2, h.country, h.country_code]
    .some((v) => v && (v.toLowerCase() === q || (q.length > 3 && v.toLowerCase().startsWith(q)))));
  const hit = hits.find(fits) ?? (want.length ? null : hits[0]);
  if (!hit) return null;
  return { name: [hit.name, hit.admin1 !== hit.name ? hit.admin1 : null, hit.country].filter(Boolean).join(', '),
    latitude: hit.latitude, longitude: hit.longitude, timezone: hit.timezone };
}

// Home as a place (looked up again only when the location setting changes).
let home = null;
export async function homePlace() {
  const { name, timezone } = household();
  if (home?.name === name) return home;
  if (!name) throw new Error('No home location is set');
  const found = await geocode(name);
  if (!found) throw new Error(`Couldn't find the home location "${name}"`);
  home = { ...found, name, timezone };
  return home;
}

// A caller's spoken answer ("I think maybe Durham in North Carolina", "Glasgow in Montana State") -> a place.
// A small, fast Claude model pulls out town, region and country (T-028: word rules couldn't keep up with how
// people talk); the word-rule lookup above is the fallback if it fails or finds nothing.
const PLACE_MODEL = process.env.PLACE_MODEL || 'claude-haiku-5-5';
let anthropic = null;
async function placeFromSpeech(said) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  anthropic ??= new Anthropic();
  const msg = await anthropic.messages.create({
    model: PLACE_MODEL,
    max_tokens: 200,
    system: 'A telephone caller was asked which town or city they want the weather for, and their answer was '
      + 'transcribed. Give the place they mean, using the standard English names. Region and country only as the '
      + 'caller said them (leave them empty otherwise), with a US state, Canadian province or similar written as '
      + 'its plain name ("Montana", not "Montana State" or "MT").',
    tools: [{
      name: 'place',
      description: 'The place the caller asked for.',
      input_schema: {
        type: 'object',
        properties: {
          town: { type: 'string', description: 'Town or city, e.g. "Glasgow". Empty if the caller named no place.' },
          region: { type: 'string', description: 'State, province or region the caller said, e.g. "Montana", else empty.' },
          country: { type: 'string', description: 'Country the caller said, e.g. "Scotland", else empty.' },
        },
        required: ['town', 'region', 'country'],
      },
    }],
    tool_choice: { type: 'tool', name: 'place' },
    messages: [{ role: 'user', content: said }],
  }, { timeout: 6000 });
  const input = msg.content.find((b) => b.type === 'tool_use')?.input;
  return input?.town?.trim() ? input : null;
}

export async function geocodeSpoken(said) {
  let p = null;
  try { p = await placeFromSpeech(said); } catch (err) { console.log(`Place understanding failed (${err.message}); using word rules`); }
  if (p) {
    const region = p.region?.trim(); const country = p.country?.trim();
    // Most specific first; drop a qualifier only if the lookup can't match it.
    const tries = [[region, country], [region], [country]].map((r) => r.filter(Boolean))
      .filter((r, i, all) => all.findIndex((x) => x.join() === r.join()) === i);
    for (const rest of tries) {
      const hit = await lookup(p.town.trim(), rest);
      if (hit) return hit;
    }
  }
  return geocode(said);
}
