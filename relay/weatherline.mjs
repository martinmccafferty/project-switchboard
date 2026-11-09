// 234 weather line (D-26, D-35, D-36): a recorded-style forecast read by the services' voice (Charon) like a
// 1960s radio bulletin. The caller dials 1 for home (the HOME_LOCATION setting) or 2 and says another place.
// The forecast repeats, with the operator hint between readings, until the caller hangs up or chooses again.
// Bulletins come from the weather lookup Doris uses (no Claude), voiced live, and are kept 15 minutes per place.
// Stored clips:  node --env-file=.env weatherline.mjs      Today's home bulletin text:  ... weatherline.mjs --text
import { getWeather } from './tools.mjs';
import { geocode, HOME_NAME } from './home.mjs';
import { createListener } from './listen.mjs';
import { numberWords, serviceSpeaker, renderPieces } from './servicevoice.mjs';
import { StreamResampler, silence } from './audio.mjs';
import { SAMPLE_RATE } from './voices.mjs';

const RATE = 16000;
const STYLE = 'A calm, warm British radio weather announcer of the 1960s: received pronunciation, clear and unhurried.';
const CACHE_MS = 15 * 60 * 1000;
export const PIECES = {
  intro: 'This is the weather bureau.',
  unavailable: "I'm sorry, the weather report is not available just now.",
  'ask-place': 'Please say the name of the town or city, and the state or country.',
  'one-moment': 'Thank you. One moment, please.',
  'not-found': "I'm sorry, I couldn't find that place.",
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
export function bulletin(w, { home = true } = {}) {
  const town = w.location.split(',')[0];
  const [, hh, mm, ap] = /^(\d+):(\d+) (AM|PM)/.exec(w.local_time_there);
  const h = (Number(hh) % 12) + (ap === 'PM' ? 12 : 0); const m = Math.floor(Number(mm) / 15) * 15;
  // Tonight: the coming hours from 6 PM to 6 AM.
  const night = w.next_24_hours.filter((x) => { const k = hourOf(x.time); return k >= 18 || k < 7; }).slice(0, 13);
  const parts = [
    `Here is the forecast for ${town}, issued at ${spokenTime(h, m)}${home ? '' : ' local time'}.`,
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

// Voiced bulletins, kept 15 minutes per place: { key: { at, pcm } } (16 kHz).
const cache = new Map();
// The menu says the home location, so it is voiced live once and then kept.
let menuPcm = null;

// Voices text in Charon's voice, sending audio to onChunk(pcm16k) as it arrives; resolves with all of it.
async function voice(text, onChunk = () => {}) {
  const speaker = await serviceSpeaker(STYLE);
  try {
    const resampler = new StreamResampler(SAMPLE_RATE, RATE); const parts = [];
    await speaker.speak(text, (chunk) => { const pcm = resampler.push(chunk); parts.push(pcm); onChunk(pcm); });
    return Buffer.concat(parts);
  } finally { speaker.close?.(); }
}
const menuText = () => `For the forecast for your home location, ${HOME_NAME}, dial one. For another location, dial two.`;
// Voices the menu ahead of the first call (called when the exchange starts), so callers never wait for it.
export async function prepareWeatherLine() { if (HOME_NAME && !menuPcm) menuPcm = await voice(menuText()); }

// One call to the weather line: { onDigit, onAudio, hangUp }. The exchange passes digits other than # and 0.
export function weatherCall({ out, clips, log = console.log }) {
  const w = clips.weather; const hint = clips.clock.operator;
  let live = true; let choice = 0;         // bumps on every new choice, so an old loop stops
  let listener = null; let waitingForPlace = false;
  const stillOn = (c) => live && c === choice;

  // Reads a place's forecast (voicing it live the first time), then hint and repeat, until a new choice.
  async function forecast(c, place) {
    const key = place ? place.name : 'home';
    let pcm = cache.get(key)?.at > Date.now() - CACHE_MS ? cache.get(key).pcm : null;
    try {
      if (!pcm) {
        const text = bulletin(await getWeather(place ? { location: place.name } : {}), { home: !place });
        let last = Promise.resolve();
        pcm = await voice(text, (chunk) => { if (stillOn(c)) last = out.play(chunk); });
        cache.set(key, { at: Date.now(), pcm });
        await last;
      } else if (stillOn(c)) await out.play(pcm);
    } catch (err) {
      log(`Weather line failed: ${err.message}`);
      if (stillOn(c)) await out.play(Buffer.concat([w.unavailable, silence(700, RATE), hint]));
      return;
    }
    while (stillOn(c)) await out.play(Buffer.concat([silence(1200, RATE), hint, silence(1500, RATE), w.intro, silence(400, RATE), pcm]));
  }

  // The menu, said twice if nothing is dialed (5 s to dial each time), then home by default.
  async function menu(c) {
    if (!HOME_NAME) { askPlace(c); return; }
    try { menuPcm ??= await voice(menuText()); } catch (err) { log(`Weather menu failed: ${err.message}`); forecast(c, null); return; }
    for (let i = 0; i < 2 && stillOn(c); i++) {
      await out.play(menuPcm);
      for (let t = 0; t < 25 && stillOn(c); t++) await new Promise((r) => setTimeout(r, 200));
    }
    if (stillOn(c)) { choice++; forecast(choice, null); }
  }

  // Asks for a place and listens; the caller's words are looked up and read.
  async function askPlace(c, tries = 0) {
    // The listener connects while the question plays, so the start of the answer isn't lost.
    listener?.close();
    listener = createListener({ onTurn: async (text) => {
      if (!stillOn(c) || !waitingForPlace) return;
      waitingForPlace = false; listener?.close(); listener = null;
      const said = text.trim().replace(/[.?!]+$/, '');
      log(`Weather line: caller asked for "${said}"`);
      out.play(w['one-moment']);
      let place = null;
      try { place = said ? await geocode(said) : null; } catch (err) { log(`Place lookup failed: ${err.message}`); }
      if (!stillOn(c)) return;
      if (place) { forecast(c, place); return; }
      await out.play(Buffer.concat([w['not-found'], silence(400, RATE)]));
      if (tries < 1) askPlace(c, tries + 1); else menu(c);
    } });
    await out.play(Buffer.concat([w['ask-place'], silence(200, RATE)]));
    if (!stillOn(c)) return;
    listener?.resume();
    waitingForPlace = true;
    // Nothing said within 10 seconds: ask again once, then back to the menu. (Mid-word: finish the turn instead.)
    setTimeout(() => {
      if (!stillOn(c) || !waitingForPlace || listener?.forceEnd()) return;
      waitingForPlace = false; listener?.close(); listener = null;
      if (tries < 1) askPlace(c, tries + 1); else menu(c);
    }, 10000);
  }

  (async () => { await out.play(Buffer.concat([w.intro, silence(400, RATE)])); if (live) menu(choice); })();

  return {
    onDigit(d) {
      if (d !== '1' && d !== '2') return;
      choice++; waitingForPlace = false; listener?.close(); listener = null; out.clear();
      if (d === '1') forecast(choice, null); else askPlace(choice);
    },
    onAudio(frame) { if (waitingForPlace && listener?.isSemanticLive()) listener.stream(frame); },
    hangUp() { live = false; waitingForPlace = false; listener?.close(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--text')) console.log(bulletin(await getWeather({})));
  else await renderPieces('clips/weather', PIECES, STYLE, { all: process.argv.includes('--all') });
}
