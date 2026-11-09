// The services' voice (D-26, D-35): Gemini Charon, for every line beyond the switchboard (clock, weather, ...).
// Doris and Ethel are the operators; Charon is the exchange's own announcer.
import fs from 'node:fs';

export const SERVICE_VOICE = { engine: 'gemini', voice: 'Charon' };
const RATE = 16000;

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
// 0-999 as words ("forty-two", "one hundred and five").
export function numberWords(n) {
  if (n < 0) return `minus ${numberWords(-n)}`;
  if (n >= 100) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${numberWords(n % 100)}` : ''}`;
  return n < 20 ? (ONES[n] || 'zero') : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
}

// A live Charon speaker in the given delivery style.
export async function serviceSpeaker(style, options = {}) {
  const { engines } = await import('./voices.mjs');
  return engines[SERVICE_VOICE.engine]({ voice: SERVICE_VOICE.voice, style, ...options });
}

// What a transcriber hears in 16 kHz audio (to check a live-voiced line says what it should).
export async function transcribe(pcm16k) {
  const OpenAI = (await import('openai')).default; const { toFile } = await import('openai');
  const { wavBuffer } = await import('./audio.mjs');
  const { text } = await new OpenAI().audio.transcriptions.create({ file: await toFile(wavBuffer(pcm16k, RATE), 'check.wav'), model: 'gpt-transcribe' });
  return text;
}

// Renders stored clips ({ name: text }) into dir as 16 kHz WAVs, each transcribed to check it says exactly its
// words (up to 3 tries), with the engine's leading and trailing silence trimmed so pieces join tightly.
// Only clips that are missing or whose words changed are rendered, unless all is true.
export async function renderPieces(dir, pieces, style, { all = false } = {}) {
  const OpenAI = (await import('openai')).default; const { toFile } = await import('openai');
  const { SAMPLE_RATE } = await import('./voices.mjs');
  const { writeWav, toPhoneRate } = await import('./audio.mjs');
  const openai = new OpenAI();
  // Numbers in a transcript ("42", "5") count as their words; hyphens, case and punctuation don't matter.
  const norm = (s) => s.toLowerCase().replace(/\d+/g, (d) => ` ${Number(d) ? numberWords(Number(d)) : 'oh'} `)
    .replace(/[^a-z' ]+/g, ' ').replace(/\b(zero|o)\b/g, 'oh').replace(/\s+/g, ' ').trim();
  const trim = (pcm) => {
    let a = 0; let b = pcm.length / 2 - 1;
    while (a < b && Math.abs(pcm.readInt16LE(a * 2)) < 400) a++;
    while (b > a && Math.abs(pcm.readInt16LE(b * 2)) < 400) b--;
    return pcm.subarray(Math.max(0, a - 240) * 2, Math.min(pcm.length / 2, b + 240) * 2);
  };
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = `${dir}/index.json`;
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : {};
  const todo = Object.entries(pieces).filter(([name, text]) => all || index[name] !== text || !fs.existsSync(`${dir}/${name}.wav`));
  if (!todo.length) { console.log(`${dir}: all clips up to date`); return 0; }
  const speaker = await serviceSpeaker(style, { maxRateLimitWaits: 10, onWait: (s) => console.log(`  (rate limited, waiting ${s} s)`) });
  let failed = 0;
  try {
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
  } finally { speaker.close?.(); }
  console.log(failed ? `${failed} clips failed the word check; run again to retry them` : `${dir}: all clips up to date`);
  return failed;
}
