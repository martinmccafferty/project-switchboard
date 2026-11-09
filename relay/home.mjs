// The household's settings (D-35), so nothing about one home is written into the code:
//   HOME_LOCATION   where home is, as a person would say it: "Morrisville, North Carolina"
//   HOME_TIMEZONE   e.g. America/New_York (needed on Railway, whose servers run on UTC)
//   TEMPERATURE_UNIT  fahrenheit (default) or celsius; wind speed follows (mph or km/h)
// The relay looks the place up itself (Open-Meteo geocoding, free, no key); HOME_LATITUDE/HOME_LONGITUDE override.
export const HOME_NAME = (process.env.HOME_LOCATION || process.env.HOME_LOCATION_NAME || '').trim();
export const HOME_TOWN = HOME_NAME.split(',')[0].trim();
export const HOME_TIMEZONE = process.env.HOME_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
export const CELSIUS = /^c/i.test(process.env.TEMPERATURE_UNIT || '');
export const UNITS = CELSIUS
  ? { temperature: 'celsius', wind: 'kmh', temperatureWord: 'Celsius', windWords: 'kilometers an hour' }
  : { temperature: 'fahrenheit', wind: 'mph', temperatureWord: 'Fahrenheit', windWords: 'miles an hour' };

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

// Home as a place (looked up once).
let home = null;
export async function homePlace() {
  if (home) return home;
  if (process.env.HOME_LATITUDE && process.env.HOME_LONGITUDE) {
    home = { name: HOME_NAME, latitude: Number(process.env.HOME_LATITUDE), longitude: Number(process.env.HOME_LONGITUDE), timezone: HOME_TIMEZONE };
  } else if (HOME_NAME) {
    const found = await geocode(HOME_NAME);
    if (!found) throw new Error(`Couldn't find HOME_LOCATION "${HOME_NAME}"`);
    home = { ...found, name: HOME_NAME };
  } else throw new Error('HOME_LOCATION is not set');
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
