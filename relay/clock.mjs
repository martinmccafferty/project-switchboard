// 123 speaking clock (D-26): "At the third stroke, it will be five forty-two and twenty seconds", then three
// pips, the third exactly on that time, every ten seconds until the caller hangs up. No Claude, no live voice:
// the words are stored clips (Gemini Charon), joined at call time, so it runs the same on the Mac or Railway.
// Render the clips once (committed):  node --env-file=.env clock.mjs   (add --all to re-render everything)
import fs from 'node:fs';
import { silence } from './audio.mjs';

const RATE = 16000;
const TZ = process.env.HOME_TIMEZONE || 'America/New_York'; // the home's time, not the server's (Railway runs on UTC)
// Audio reaches the ear a little after it is scheduled (send lead + the phone's playout buffer), so the pips are
// sent this much early. Re-tune after the move to Railway and again on the real phone.
const LATENCY_MS = Number(process.env.CLOCK_LATENCY_MS ?? 150);
const VOICE = { engine: 'gemini', voice: 'Charon' };
const STYLE = 'A calm, precise British speaking-clock announcer of the 1960s: received pronunciation, measured and even, '
  + 'neutral and authoritative, every word distinct.';

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];
const words = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));

// Every piece the clock can say: prefix, hour, minute, seconds.
export const PIECES = {
  prefix: 'At the third stroke, it will be',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`h${i + 1}`, words(i + 1)])),
  oclock: "o'clock",
  ...Object.fromEntries(Array.from({ length: 59 }, (_, i) => [`m${i + 1}`, i + 1 < 10 ? `oh ${words(i + 1)}` : words(i + 1)])),
  precisely: 'precisely',
  ...Object.fromEntries([10, 20, 30, 40, 50].map((s) => [`s${s}`, `and ${words(s)} seconds`])),
  // Every fourth cycle, in place of a time (Martin: callers need to learn the way back to the operator).
  operator: 'To speak to the operator, dial the pound sign or zero.',
};
const STROKES_BETWEEN_HINTS = 3;

// The home time at an instant, as clip names.
function sayTime(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h12', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  const sec = Math.round(p.second / 10) * 10;
  return ['prefix', `h${p.hour}`, p.minute ? `m${p.minute}` : 'oclock', sec ? `s${sec}` : 'precisely'];
}

const GAPS = [70, 40, 90]; // ms between prefix | hour | minute | seconds
function speech(clips, ms) {
  const parts = [];
  sayTime(ms).forEach((name, i) => { parts.push(clips[name]); if (i < 3) parts.push(silence(GAPS[i], RATE)); });
  return Buffer.concat(parts);
}

// Three 1 kHz pips, 0.1 s, one second apart (5 ms ramps, so no clicks).
const PIP = (() => {
  const n = RATE / 10; const pip = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pip.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / RATE) * 9000 * Math.min(1, i / 80, (n - i) / 80)), i * 2);
  return pip;
})();
const bytesAt = (ms) => Math.round((ms * RATE) / 1000) * 2;

// One stretch of line audio: speech starting at speechAt ms, pips at length-2100, -1100 and -100 (the third ends
// the buffer). Buffers play back to back, so the next announcement follows straight after the third pip.
function stroke(clips, strokeMs, lengthMs, speechAt) {
  const buf = Buffer.alloc(bytesAt(lengthMs));
  const words = speech(clips, strokeMs);
  if (speechAt * 1 + words.length / 2 / RATE * 1000 > lengthMs - 2300) return null; // speech would run into the pips
  words.copy(buf, bytesAt(speechAt));
  for (const back of [2100, 1100, 100]) PIP.copy(buf, bytesAt(lengthMs - back));
  return buf;
}

// Plays the clock on a line until isLive() turns false. out.play queues audio at real-time pace.
export async function speakingClock({ out, clips, isLive }) {
  const c = clips.clock;
  // First stroke: the next ten-second mark there's room for, with the time spoken just before its pips (not
  // straight away and then a long silence). If the wait is long enough, the operator hint fills it first.
  const t0 = Date.now(); const ms = (pcm) => (pcm.length / 2 / RATE) * 1000;
  let strokeMs = Math.ceil((t0 + LATENCY_MS) / 10000) * 10000; let first = null;
  for (;;) {
    const length = strokeMs - LATENCY_MS + 100 - t0;
    const speechAt = length - 2300 - ms(speech(c, strokeMs)) - 200;
    if (speechAt >= 300) {
      first = stroke(c, strokeMs, length, speechAt);
      if (speechAt >= 300 + ms(c.operator) + 600) c.operator.copy(first, bytesAt(300));
      break;
    }
    strokeMs += 10000;
  }
  // Keep two strokes queued, so the line never runs dry between them (that would let the timing slip).
  // Three strokes, then a ten-second cycle that says how to reach the operator (no pips), and round again.
  let count = 1;
  const next = () => {
    strokeMs += 10000;
    if (count++ % (STROKES_BETWEEN_HINTS + 1) === STROKES_BETWEEN_HINTS) {
      const hint = Buffer.alloc(bytesAt(10000)); c.operator.copy(hint, bytesAt(800)); return hint;
    }
    return stroke(c, strokeMs, 10000, 500);
  };
  const queued = [out.play(first), out.play(next())];
  while (isLive()) {
    await queued.shift();
    if (!isLive()) break;
    queued.push(out.play(next()));
  }
}

// --- Rendering the clips (run this file directly).
if (import.meta.url === `file://${process.argv[1]}`) {
  const OpenAI = (await import('openai')).default; const { toFile } = await import('openai');
  const { engines, SAMPLE_RATE } = await import('./voices.mjs');
  const { writeWav, toPhoneRate } = await import('./audio.mjs');
  const openai = new OpenAI();
  // Numbers in a transcript ("42", "5") count as their words; hyphens, case and punctuation don't matter.
  const norm = (s) => s.toLowerCase().replace(/\d+/g, (d) => ` ${words(Number(d)) || 'oh'} `).replace(/[^a-z' ]+/g, ' ')
    .replace(/\b(zero|o)\b/g, 'oh').replace(/\s+/g, ' ').trim();
  // Cut the voice engine's leading and trailing silence (keep 15 ms), so the pieces join tightly.
  const trim = (pcm) => {
    let a = 0; let b = pcm.length / 2 - 1;
    while (a < b && Math.abs(pcm.readInt16LE(a * 2)) < 400) a++;
    while (b > a && Math.abs(pcm.readInt16LE(b * 2)) < 400) b--;
    return pcm.subarray(Math.max(0, a - 240) * 2, Math.min(pcm.length / 2, b + 240) * 2);
  };
  const dir = 'clips/clock'; fs.mkdirSync(dir, { recursive: true });
  const indexPath = `${dir}/index.json`;
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : {};
  const all = process.argv.includes('--all');
  const todo = Object.entries(PIECES).filter(([name, text]) => all || index[name] !== text || !fs.existsSync(`${dir}/${name}.wav`));
  const speaker = await engines[VOICE.engine]({ voice: VOICE.voice, style: STYLE, maxRateLimitWaits: 10,
    onWait: (s) => console.log(`  (rate limited, waiting ${s} s)`) });
  let failed = 0;
  for (const [name, text] of todo) {
    let ok = false; let heard = '';
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const { pcm } = await speaker.speak(text);
      writeWav(`${dir}/.check.wav`, pcm, SAMPLE_RATE);
      heard = (await openai.audio.transcriptions.create({ file: await toFile(fs.readFileSync(`${dir}/.check.wav`), 'c.wav'), model: 'gpt-transcribe' })).text;
      ok = norm(heard) === norm(text);
      if (ok) { writeWav(`${dir}/${name}.wav`, trim(toPhoneRate(pcm, SAMPLE_RATE, RATE)), RATE); index[name] = text; }
    }
    fs.rmSync(`${dir}/.check.wav`, { force: true });
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
    console.log(`  ${name}: ${ok ? 'ok' : `FAILED (heard "${heard}")`}  "${text}"`);
    if (!ok) failed++;
  }
  speaker.close?.();
  console.log(failed ? `${failed} pieces failed the word check; run again to retry them` : 'All clock pieces up to date');
}
