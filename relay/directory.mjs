// 411 directory (D-26, D-27, D-43): Charon reads the exchange's numbers, built from the services list, three times,
// then the line disconnects. Each line has a one-digit shortcut while it reads (Martin): dial 1 for the first, and so
// on; its own number is read too, so callers learn it. # or 0 reaches the operator.
// Star at dial tone comes here too. The reading is voiced once and kept while the list is unchanged.
import { SERVICES } from './services.mjs';
import { serviceSpeaker, transcribe } from './servicevoice.mjs';
import { StreamResampler, silence, waitingCue } from './audio.mjs';
import { SAMPLE_RATE } from './voices.mjs';

const RATE = 16000;
const STYLE = 'A calm, precise British telephone exchange announcer of the 1960s: received pronunciation, measured and clear.';
const MAX_READINGS = Number(process.env.DIRECTORY_MAX_READINGS) || 3; // Martin: 3 (was 5)
const TICK = waitingCue('clock-tick', 10000, RATE);
const DIGIT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const spoken = (number) => number.split('').map((d) => DIGIT[d]).join(' ');

// The lines in reading order; shortcut key = position (1-9).
export const directoryLines = () => SERVICES.filter((s) => s.id !== 'directory').slice(0, 9);
export const directoryText = () => ['Directory. Dial a single number to be connected.', 'For the operator, dial zero.',
  ...directoryLines().map((s, i) => `For ${s.name}, dial ${DIGIT[i + 1]}; its number is ${spoken(s.number)}.`),
  'Or hang up.'].join(' ');

let kept = null; // { text, pcm }
// Voices the reading (checked by transcription: every service's number should be heard), or returns the kept one.
export async function prepareDirectory() {
  const text = directoryText();
  if (kept?.text === text) return kept.pcm;
  const numbers = directoryLines().map((s) => s.number);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const speaker = await serviceSpeaker(STYLE);
    let pcm;
    try {
      const resampler = new StreamResampler(SAMPLE_RATE, RATE); const parts = [];
      await speaker.speak(text, (chunk) => parts.push(resampler.push(chunk)));
      pcm = Buffer.concat(parts);
    } finally { speaker.close?.(); }
    // "one two three" may come back as "123" or "1, 2, 3": compare digits only.
    const heard = (await transcribe(pcm).catch(() => '')).toLowerCase()
      .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => String(DIGIT.indexOf(w))).replace(/[^0-9a-z]+/g, '');
    const ok = numbers.every((n) => heard.includes(n));
    if (ok || attempt === 3) {
      kept = { text, pcm };
      console.log(`Directory voiced${ok ? '' : ' (unchecked: a number may be misread)'}`);
      return pcm;
    }
    console.log('Directory: a number was misread; voicing again');
  }
}

// One call to the directory. The exchange handles digits (a new number, # or 0); onFinished() after the readings.
export function directoryCall({ out, log = console.log, onFinished = () => {} }) {
  let live = true;
  (async () => {
    let pcm;
    try {
      if (!kept || kept.text !== directoryText()) out.setFiller(TICK);
      pcm = await prepareDirectory();
    } catch (err) { log(`Directory failed: ${err.message}`); out.setFiller(null); if (live) onFinished(); return; }
    out.setFiller(null);
    for (let i = 0; i < MAX_READINGS && live; i++) await out.play(Buffer.concat([pcm, silence(3000, RATE)]));
    if (live) onFinished();
  })();
  return { onDigit() {}, onAudio() {}, hangUp() { live = false; out.setFiller(null); } };
}
