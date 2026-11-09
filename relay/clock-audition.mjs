// 123 speaking clock voice audition (D-26): one announcement plus the three pips, in several British-style
// voices on both engines, as heard through the handset.  Run from the relay folder:  node --env-file=.env clock-audition.mjs
// Writes audition/clock-<engine>-<voice>.wav (git-ignored).
import fs from 'node:fs';
import { engines, SAMPLE_RATE } from './voices.mjs';
import { writeWav, silence, phoneLine } from './audio.mjs';

const RATE = 16000;
const STYLE = 'A calm, precise British speaking-clock announcer of the 1960s: received pronunciation, measured and even, '
  + 'neutral and authoritative, every word distinct.';
const LINE = 'At the third stroke, it will be five forty-two and twenty seconds.';
const CANDIDATES = [
  ['openai', 'cedar'], ['openai', 'marin'], ['openai', 'ballad'],
  ['gemini', 'Charon'], ['gemini', 'Algieba'], ['gemini', 'Kore'],
];

// Three 1 kHz pips, 0.1 s each, one second apart (the third marks the exact time).
function pips() {
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const pip = Buffer.alloc(RATE * 0.1 * 2);
    for (let n = 0; n < RATE * 0.1; n++) {
      const edge = Math.min(1, n / 80, (RATE * 0.1 - n) / 80); // 5 ms ramps, no clicks
      pip.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * n) / RATE) * 9000 * edge), n * 2);
    }
    parts.push(pip, silence(k < 2 ? 900 : 300, RATE));
  }
  return Buffer.concat(parts);
}

fs.mkdirSync('audition', { recursive: true });
for (const [engine, voice] of CANDIDATES) {
  try {
    const speaker = await engines[engine]({ voice, style: STYLE, maxRateLimitWaits: 5 });
    const { pcm } = await speaker.speak(LINE);
    speaker.close?.();
    const spoken = phoneLine(pcm, SAMPLE_RATE, RATE);
    // Twice round, as a caller would hear it.
    const cycle = Buffer.concat([spoken, silence(400, RATE), pips(), silence(600, RATE)]);
    writeWav(`audition/clock-${engine}-${voice}.wav`, Buffer.concat([cycle, cycle]), RATE);
    console.log(`clock-${engine}-${voice}.wav  (${(spoken.length / 2 / RATE).toFixed(1)} s of speech)`);
  } catch (err) { console.log(`${engine}/${voice}: failed (${err.message})`); }
}
