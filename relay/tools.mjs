// Operator tools (M1): time and weather. Each tool = a definition Claude sees + a function the relay runs.
// Weather uses Open-Meteo (free, no API key). Default location: Morrisville, NC.

const HOME = {
  name: process.env.HOME_LOCATION_NAME || 'Morrisville, North Carolina',
  latitude: Number(process.env.HOME_LATITUDE) || 35.8235,
  longitude: Number(process.env.HOME_LONGITUDE) || -78.8256,
  timezone: process.env.HOME_TIMEZONE || 'America/New_York',
};

// WMO weather codes -> plain words (https://open-meteo.com/en/docs)
const WEATHER_WORDS = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'heavy freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'heavy freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorms',
  96: 'thunderstorms with hail', 99: 'thunderstorms with heavy hail',
};

export const toolDefinitions = [
  {
    name: 'get_time',
    description: "Current local date and time at the caller's home (or another IANA time zone if asked).",
    input_schema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA time zone, e.g. "Europe/London". Omit for home.' },
      },
    },
  },
  {
    name: 'get_weather',
    description: "Current weather and today's/tomorrow's forecast. Omit location for the caller's home.",
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name, e.g. "Raleigh" or "Dublin". Omit for home.' },
      },
    },
  },
];

// What the operator says while a tool runs (D-21). Every new tool gets a line here; later each becomes a stored clip.
export const toolAnnouncements = {
  get_time: 'One moment, let me check the clock.',
  get_weather: "One moment, I'll ring the weather bureau.",
};

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

function getTime({ timezone } = {}) {
  const zone = timezone || HOME.timezone;
  const text = new Date().toLocaleString('en-US', {
    timeZone: zone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  return { timezone: zone, local_time: text };
}

async function getWeather({ location } = {}) {
  let place = HOME;
  if (location) {
    const geo = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`);
    const hit = geo.results?.[0];
    if (!hit) return { error: `No place found called "${location}".` };
    place = { name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
      latitude: hit.latitude, longitude: hit.longitude };
  }
  const w = await fetchJson('https://api.open-meteo.com/v1/forecast'
    + `?latitude=${place.latitude}&longitude=${place.longitude}`
    + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=2');
  const day = (i) => ({
    conditions: WEATHER_WORDS[w.daily.weather_code[i]] ?? 'unknown',
    high_f: Math.round(w.daily.temperature_2m_max[i]),
    low_f: Math.round(w.daily.temperature_2m_min[i]),
    chance_of_rain_percent: w.daily.precipitation_probability_max[i],
  });
  return {
    location: place.name,
    now: {
      conditions: WEATHER_WORDS[w.current.weather_code] ?? 'unknown',
      temperature_f: Math.round(w.current.temperature_2m),
      feels_like_f: Math.round(w.current.apparent_temperature),
      wind_mph: Math.round(w.current.wind_speed_10m),
    },
    today: day(0),
    tomorrow: day(1),
  };
}

const handlers = { get_time: getTime, get_weather: getWeather };

// Runs a tool and returns a JSON string for Claude. Errors come back as { error } so Claude can apologize gracefully.
export async function runTool(name, input) {
  const handler = handlers[name];
  if (!handler) return { content: JSON.stringify({ error: `Unknown tool ${name}` }), isError: true };
  try {
    return { content: JSON.stringify(await handler(input ?? {})), isError: false };
  } catch (err) {
    return { content: JSON.stringify({ error: err.message }), isError: true };
  }
}
