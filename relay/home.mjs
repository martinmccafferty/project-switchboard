// The household's settings (D-35), so nothing about one home is written into the code:
//   HOME_LOCATION   where home is, as a person would say it: "Morrisville, North Carolina"
//   HOME_TIMEZONE   e.g. America/New_York (needed on Railway, whose servers run on UTC)
// The relay looks the place up itself (Open-Meteo geocoding, free, no key); HOME_LATITUDE/HOME_LONGITUDE override.
export const HOME_NAME = (process.env.HOME_LOCATION || process.env.HOME_LOCATION_NAME || '').trim();
export const HOME_TOWN = HOME_NAME.split(',')[0].trim();
export const HOME_TIMEZONE = process.env.HOME_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

const US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia' };

// "Portland, Oregon" / "Portland, OR" / "Paris, France" / "Greenock" -> { name, latitude, longitude, timezone },
// or null. The search takes a bare place name, so the rest ("Oregon") picks among the matches.
export async function geocode(query) {
  const [place, ...rest] = query.split(',').map((s) => s.trim()).filter(Boolean);
  if (!place) return null;
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
