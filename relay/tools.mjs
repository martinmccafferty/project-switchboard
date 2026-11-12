// Operator tools: time and weather (M1), reminders and blinds (M4), lights through the home bridge (D-48). Each tool = a definition Claude sees + a function the relay runs.
import { reminderTools, reminderHandlers } from './reminders.mjs';
import { homeTools, homeHandlers } from './switchbot.mjs';
import { lightsTools, lightsHandlers } from './lights.mjs';
import { routineTools, routineHandlers } from './routines.mjs';
import { thermostatTools, thermostatHandlers } from './house.mjs';
import { shoppingTools, shoppingHandlers } from './shopping.mjs';
import { household, geocode, homePlace } from './home.mjs';
// Weather uses Open-Meteo (free, no API key); home is the HOME_LOCATION setting (home.mjs).

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

const baseTools = [
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
    description: "Current weather, an hour-by-hour forecast for the next 24 hours, and today's/tomorrow's "
      + "forecast. Omit location for the caller's home.",
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
  move_blinds: 'Right away.',
  connect_call: 'Right away.', // the tool itself lives in services.mjs
  blinds_status: 'One moment, let me take a look.',
  switch_lights: 'Right away.',
  lights_status: 'One moment, let me take a look.',
  thermostat_status: 'One moment, let me take a look.',
  set_thermostat: 'Right away.',
  run_routine: 'Right away.',
  list_routines: 'One moment, let me take a look.',
};

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

function getTime({ timezone } = {}) {
  const zone = timezone || household().timezone;
  const text = new Date().toLocaleString('en-US', {
    timeZone: zone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  return { timezone: zone, local_time: text };
}

export async function getWeather({ location } = {}) {
  const place = location ? await geocode(location) : await homePlace();
  if (!place) return { error: `No place found called "${location}".` };
  const { units } = household();
  const w = await fetchJson('https://api.open-meteo.com/v1/forecast'
    + `?latitude=${place.latitude}&longitude=${place.longitude}`
    + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m'
    + '&hourly=temperature_2m,weather_code,precipitation_probability&forecast_hours=24'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + `&temperature_unit=${units.temperature}&wind_speed_unit=${units.wind}&timezone=auto&forecast_days=2`);
  // "2026-11-08T14:00" (already the place's local time) -> "2 PM Sunday"
  const label = (iso) => {
    const d = new Date(`${iso}:00Z`);
    return `${d.getUTCHours() % 12 || 12} ${d.getUTCHours() < 12 ? 'AM' : 'PM'} `
      + d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  };
  const day = (i) => ({
    conditions: WEATHER_WORDS[w.daily.weather_code[i]] ?? 'unknown',
    high: Math.round(w.daily.temperature_2m_max[i]),
    low: Math.round(w.daily.temperature_2m_min[i]),
    chance_of_rain_percent: w.daily.precipitation_probability_max[i],
  });
  return {
    location: place.name,
    units: `temperatures in degrees ${units.temperatureWord}, wind in ${units.windWords}`,
    local_time_there: label(w.current.time.slice(0, 13) + ':00').replace(/^(\d+) /, `$1:${w.current.time.slice(14, 16)} `),
    now: {
      conditions: WEATHER_WORDS[w.current.weather_code] ?? 'unknown',
      temperature: Math.round(w.current.temperature_2m),
      feels_like: Math.round(w.current.apparent_temperature),
      wind_speed: Math.round(w.current.wind_speed_10m),
    },
    next_24_hours: w.hourly.time.map((t, i) => ({
      time: label(t),
      temperature: Math.round(w.hourly.temperature_2m[i]),
      conditions: WEATHER_WORDS[w.hourly.weather_code[i]] ?? 'unknown',
      chance_of_rain_percent: w.hourly.precipitation_probability[i],
    })),
    today: day(0),
    tomorrow: day(1),
  };
}

// Read per request: the home tools follow the household's rooms in the settings.
// Routines (D-49): everyone may run and list them; making and removing them is the porter's job (homeline.mjs).
export const toolDefinitions = () => [...baseTools, ...reminderTools, ...shoppingTools, ...homeTools(), ...lightsTools(), ...thermostatTools(),
  ...((homeTools().length || lightsTools().length) ? routineTools().filter((t) => ['run_routine', 'list_routines'].includes(t.name)) : [])];
const handlers = { get_time: getTime, get_weather: getWeather, ...reminderHandlers, ...homeHandlers, ...lightsHandlers, ...routineHandlers, ...thermostatHandlers, ...shoppingHandlers };

// Runs a tool and returns a JSON string for Claude. Errors come back as { error } so Claude can apologize gracefully.
export async function runTool(name, input) {
  const handler = handlers[name];
  if (!handler) return { content: JSON.stringify({ error: `Unknown tool ${name}` }), isError: true };
  console.log(`Tool ${name} ${JSON.stringify(input ?? {})}`);
  try {
    return { content: JSON.stringify(await handler(input ?? {})), isError: false };
  } catch (err) {
    return { content: JSON.stringify({ error: err.message }), isError: true };
  }
}
