// Stored clips (D-17, D-21, D-24): lines the phone plays instantly instead of waiting for a live voice.
// Run from the relay folder:  npm run clips            (renders only clips that are missing or whose words changed)
//                             npm run clips -- --all   (re-renders everything)
// Writes clips/<operator>/<name>.wav at the phone's 16 kHz and clips/index.json (what each clip says).
// Clips are committed: they are part of the phone, and re-rendering would change the voice slightly.
import fs from 'node:fs';
import OpenAI, { toFile } from 'openai';
import { operatorSpeaker, SAMPLE_RATE } from './voices.mjs';
import { toolAnnouncements } from './tools.mjs';
import { writeWav, toPhoneRate, plugClick, silence } from './audio.mjs';

const PHONE_RATE = 16000;
const CLIPS = {
  doris: {
    greeting: { text: 'Operator. How may I help you?', click: true },
    connecting: { text: 'One moment, connecting you.' },
    ...Object.fromEntries(Object.entries(toolAnnouncements).map(([tool, text]) => [`announce-${tool}`, { text }])),
    // Exchange announcements (D-26). 911: this phone cannot reach emergency services, so say so plainly.
    'no-emergency': { text: 'This telephone cannot reach emergency services. Please hang up and dial nine one one from a mobile phone.' },
    'not-in-service': { text: "I'm sorry, the number you have dialed is not in service. Please hang up and dial zero for the operator." },
    'echo-test': { text: "Echo test line. Speak, and you'll hear yourself." },
  },
  ethel: {
    greeting: { text: 'Operator. How may I help you?', click: true },
    // Taking over when Doris's voice fails mid-call (D-24).
    takeover: { text: "Hello? Sorry about that. Doris has gone home with a head cold, so I'm minding her board tonight. Now, where were we?", click: true },
    // When the caller asks for her (D-25).
    pickup: { text: 'Ethel speaking. How may I help you?', click: true },
    connecting: { text: 'One moment, connecting you.' },
    ...Object.fromEntries(Object.entries(toolAnnouncements).map(([tool, text]) => [`announce-${tool}`, { text }])),
  },
};

const openai = new OpenAI();
// Spoken single digits ("nine one one") and written ones ("911") count as the same.
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean)
  .map((w) => (DIGITS.includes(w) ? String(DIGITS.indexOf(w)) : w)).join(' ').replace(/(\d) (?=\d)/g, '$1');

// Transcribes a clip to make sure it says exactly its script (numbers written as digits count as a pass).
async function heardRight(pcm, text) {
  writeWav('clips/.check.wav', pcm, SAMPLE_RATE);
  const file = await toFile(fs.readFileSync('clips/.check.wav'), 'check.wav');
  const { text: heard } = await openai.audio.transcriptions.create({ file, model: process.env.OPENAI_STT_MODEL || 'gpt-transcribe' });
  fs.rmSync('clips/.check.wav');
  return { ok: words(heard) === words(text), heard };
}

const all = process.argv.includes('--all');
const indexPath = 'clips/index.json';
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : {};

for (const [operator, clips] of Object.entries(CLIPS)) {
  fs.mkdirSync(`clips/${operator}`, { recursive: true });
  const todo = Object.entries(clips).filter(([name, c]) =>
    all || index[operator]?.[name]?.text !== c.text || index[operator]?.[name]?.click !== !!c.click
      || !fs.existsSync(`clips/${operator}/${name}.wav`));
  if (!todo.length) { console.log(`${operator}: all clips up to date`); continue; }

  const speaker = await operatorSpeaker(operator, { maxRateLimitWaits: 5 });
  try {
    for (const [name, clip] of todo) {
      let result; let check;
      for (let attempt = 1; attempt <= 3; attempt++) {
        result = await speaker.speak(clip.text);
        check = await heardRight(result.pcm, clip.text);
        if (check.ok) break;
        console.log(`  ${operator}/${name}: attempt ${attempt} said "${check.heard}", trying again`);
      }
      if (!check.ok) { console.log(`  ${operator}/${name}: FAILED word-for-word check, kept old clip`); continue; }
      const speech = toPhoneRate(result.pcm, SAMPLE_RATE, PHONE_RATE);
      const pcm = clip.click ? Buffer.concat([plugClick(PHONE_RATE), silence(120, PHONE_RATE), speech]) : speech;
      writeWav(`clips/${operator}/${name}.wav`, pcm, PHONE_RATE);
      (index[operator] ??= {})[name] = { text: clip.text, click: !!clip.click, seconds: +(pcm.length / 2 / PHONE_RATE).toFixed(2) };
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
      console.log(`  ${operator}/${name}: ok (${index[operator][name].seconds} s) "${clip.text}"`);
    }
  } finally {
    speaker.close();
  }
}
console.log('Listen:  open clips');
