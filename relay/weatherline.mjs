// 234 weather line (D-26, D-35): a recorded-style forecast for home, read by the services' voice (Charon) like a
// 1960s radio bulletin, repeating until the caller hangs up, with the operator hint between readings.
// The bulletin is built from the weather lookup Doris uses (no Claude), voiced live, and kept for 15 minutes so
// later callers hear it at once. Stored clips (intro, unavailable): node --env-file=.env weatherline.mjs
import { getWeather, HOME } from './tools.mjs';
import { numberWords, serviceSpeaker, renderPieces } from './servicevoice.mjs';
import { StreamResampler, silence } from './audio.mjs';
import { SAMPLE_RATE } from './voices.mjs';

const RATE = 16000;
const STYLE = 'A calm, warm British radio weather announcer of the 1960s: received pronunciation, clear and unhurried.';
const CACHE_MS = 15 * 60 * 1000;
export const PIECES = {
  intro: 'This is the weather bureau.',
  unavailable: "I'm sorry, the weather report is not available just now.",
};

const deg = (n) => `${numberWords(n)} degree${Math.abs(n) === 1 ? '' : 's'}`;
const hourOf = (label) => { const [, h, ap] = /^(\d+)(?::\d+)? (AM|PM)/.exec(label); return (Number(h) % 12) + (ap === 'PM' ? 12 : 0); };
const wind = (mph) => (mph < 8 ? 'Winds are light.' : mph < 20 ? `There is a breeze of ${numberWords(mph)} miles an hour.`
  : `Winds are strong, at ${numberWords(mph)} miles an hour.`);
// The lookup's words ("clear sky", "light rain") as a bulletin says them.
const sky = (c) => (c === 'clear sky' ? 'clear skies' : c);
const atPresent = (c) => (c === 'clear sky' ? 'under clear skies' : /^(mainly clear|partly cloudy|overcast)$/.test(c) ? `and ${c}` : `with ${c}`);
const rain = (pct) => (pct >= 20 ? `, with a ${numberWords(Math.round(pct / 10) * 10)} percent chance of rain` : '');
const mostCommon = (xs) => Object.entries(xs.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0]?.[0];
function spokenTime(h, m) {
  const hour = numberWords(h % 12 || 12); const part = h < 12 ? 'in the morning' : h < 18 ? 'in the afternoon' : 'in the evening';
  return m === 0 ? `${hour} o'clock ${part}` : `${hour} ${m < 10 ? `oh ${numberWords(m)}` : numberWords(m)} ${part}`;
}

// The bulletin text, from the weather lookup's data.
export function bulletin(w) {
  const town = HOME.name.split(',')[0];
  const [, hh, mm, ap] = /^(\d+):(\d+) (AM|PM)/.exec(w.local_time_there);
  const h = (Number(hh) % 12) + (ap === 'PM' ? 12 : 0); const m = Math.floor(Number(mm) / 15) * 15;
  // Tonight: the coming hours from 6 PM to 6 AM.
  const night = w.next_24_hours.filter((x) => { const k = hourOf(x.time); return k >= 18 || k < 7; }).slice(0, 13);
  const parts = [
    `Here is the forecast for ${town}, issued at ${spokenTime(h, m)}.`,
    `At present it is ${deg(w.now.temperature_f)} ${atPresent(w.now.conditions)}. ${wind(w.now.wind_mph)}`,
  ];
  if (h < 15) parts.push(`For the rest of today, ${sky(w.today.conditions)}, with a high of ${deg(w.today.high_f)}${rain(w.today.chance_of_rain_percent)}.`);
  if (night.length) {
    parts.push(`Tonight, ${sky(mostCommon(night.map((x) => x.conditions)))}, with a low near ${deg(Math.min(...night.map((x) => x.temperature_f)))}`
      + `${rain(Math.max(...night.map((x) => x.chance_of_rain_percent ?? 0)))}.`);
  }
  parts.push(`Tomorrow, ${sky(w.tomorrow.conditions)}, with a high of ${deg(w.tomorrow.high_f)} and a low of ${deg(w.tomorrow.low_f)}`
    + `${rain(w.tomorrow.chance_of_rain_percent)}.`, 'That is the end of the forecast.');
  return parts.join(' ');
}

let cached = null; // { at, pcm } at 16 kHz

// Voices the current bulletin, sending audio to onChunk(pcm16k) as it is generated; resolves with the whole of it.
async function voiceBulletin(onChunk) {
  const text = bulletin(await getWeather({}));
  const speaker = await serviceSpeaker(STYLE);
  try {
    const resampler = new StreamResampler(SAMPLE_RATE, RATE); const parts = [];
    await speaker.speak(text, (chunk) => { const pcm = resampler.push(chunk); parts.push(pcm); onChunk(pcm); });
    return Buffer.concat(parts);
  } finally { speaker.close?.(); }
}

// Plays the weather line until isLive() turns false.
export async function weatherLine({ out, clips, isLive, log = console.log }) {
  const hint = clips.clock.operator; const w = clips.weather;
  out.play(w.intro); out.play(silence(400, RATE));
  let bulletinPcm = cached && Date.now() - cached.at < CACHE_MS ? cached.pcm : null;
  if (!bulletinPcm) {
    try {
      let last = Promise.resolve();
      bulletinPcm = await voiceBulletin((pcm) => { if (isLive()) last = out.play(pcm); });
      cached = { at: Date.now(), pcm: bulletinPcm };
      await last;
    } catch (err) {
      log(`Weather line failed: ${err.message}`);
      while (isLive()) { await out.play(Buffer.concat([w.unavailable, silence(700, RATE), hint, silence(4000, RATE)])); }
      return;
    }
  } else {
    await out.play(bulletinPcm);
  }
  // Then: the operator hint, and the bulletin again, until the caller hangs up.
  while (isLive()) {
    await out.play(Buffer.concat([silence(1200, RATE), hint, silence(1500, RATE), w.intro, silence(400, RATE), bulletinPcm]));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--text')) console.log(bulletin(await getWeather({})));
  else await renderPieces('clips/weather', PIECES, STYLE, { all: process.argv.includes('--all') });
}
