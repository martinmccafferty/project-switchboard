// M2 voice round trip with files: caller audio -> transcription -> Doris (Claude) -> Doris's voice -> WAV.
// Run from the relay folder:  npm run roundtrip                       (a Mac test voice asks the question)
//                             npm run roundtrip -- question.m4a       (your own recording)
//                             npm run roundtrip -- --say "Is it going to rain tomorrow?"
// Writes roundtrip/question.wav, reply.wav and reply-phone.wav, and prints where the time went.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import OpenAI, { toFile } from 'openai';
import { createOperator } from './operator.mjs';
import { operatorSpeaker, SAMPLE_RATE } from './voices.mjs';
import { writeWav, silence, phoneLine } from './audio.mjs';

const STT_MODEL = process.env.OPENAI_STT_MODEL || 'gpt-transcribe';
const openai = new OpenAI();
fs.mkdirSync('roundtrip', { recursive: true });

// 1. The caller's audio: a recording, or the Mac's built-in voice saying a test question at the phone's 16 kHz.
const args = process.argv.slice(2);
let questionFile = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--say');
if (!questionFile) {
  const said = args.includes('--say') ? args[args.indexOf('--say') + 1] : "What's the weather going to be like tomorrow?";
  execFileSync('say', ['-v', 'Samantha', '-o', 'roundtrip/question.aiff', said]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', 'roundtrip/question.aiff', 'roundtrip/question.wav']);
  fs.rmSync('roundtrip/question.aiff');
  questionFile = 'roundtrip/question.wav';
  console.log(`Test caller (Mac voice) says: "${said}"`);
}

// On a real call the voice connection opens while the greeting clip plays, so it isn't counted below.
let t = Date.now();
const doris = await operatorSpeaker('doris');
const connectMs = Date.now() - t;

// 2. Transcription. The clock starts when the caller stops speaking.
const t0 = Date.now();
const { text: heard } = await openai.audio.transcriptions.create({
  file: await toFile(fs.readFileSync(questionFile), questionFile.split('/').pop()),
  model: STT_MODEL,
});
const sttMs = Date.now() - t0;
console.log(`Heard: "${heard}"`);

// 3 + 4. Doris thinks and speaks. Each finished sentence goes to the voice while Claude writes the next.
const queue = []; let wake = null; let finished = false;
const say = (sentence) => { queue.push(sentence); wake?.(); };
let firstTextMs = null; let firstSoundMs = null; let pendingText = '';
const pieces = []; const spoken = []; const timeline = [];

const speaking = (async () => {
  while (true) {
    if (!queue.length) {
      if (finished) return;
      await new Promise((r) => { wake = r; }); wake = null;
      continue;
    }
    const sentence = queue.shift();
    const startedAt = Date.now() - t0;
    const r = await doris.speak(sentence);
    firstSoundMs ??= startedAt + r.firstAudioMs;
    pieces.push(r.pcm, silence(150, SAMPLE_RATE));
    spoken.push(sentence);
    timeline.push({ at: startedAt + r.firstAudioMs, sentence });
  }
})();

const operator = createOperator({
  onAnnounce: (phrase) => say(phrase), // a stored clip on a real call; spoken live here
  onText: (delta) => {
    firstTextMs ??= Date.now() - t0;
    pendingText += delta;
    // Hand over every complete sentence (ends with . ! or ? followed by a space).
    let m;
    while ((m = pendingText.match(/^(.+?[.!?]["')]?)\s+/s))) {
      say(m[1].trim()); pendingText = pendingText.slice(m[0].length);
    }
  },
});
const reply = await operator.ask(heard);
const claudeMs = Date.now() - t0;
if (pendingText.trim()) say(pendingText.trim());
finished = true; wake?.();
await speaking;
const doneMs = Date.now() - t0;
doris.close();

const pcm = Buffer.concat(pieces);
writeWav('roundtrip/reply.wav', pcm, SAMPLE_RATE);
writeWav('roundtrip/reply-phone.wav', phoneLine(pcm, SAMPLE_RATE), 16000);

console.log(`Doris: "${spoken.join(' ')}"\n`);
const s = (ms) => `${(ms / 1000).toFixed(1)} s`;
console.log('Where the time went (from the moment the caller stops talking):');
console.log(`  Transcription done            ${s(sttMs)}`);
console.log(`  Claude's first words          ${s(firstTextMs)}`);
console.log(`  Doris starts speaking         ${s(firstSoundMs)}   <- the silence the caller hears`);
console.log(`  Claude finished writing       ${s(claudeMs)}`);
console.log(`  Doris's last sentence ready   ${s(doneMs)}   (${(pcm.length / 2 / SAMPLE_RATE).toFixed(1)} s of speech)`);
console.log(`  (voice connection opened beforehand in ${s(connectMs)}, during the greeting on a real call)`);
console.log('\nEach sentence ready to play at:');
for (const { at, sentence } of timeline) console.log(`  ${s(at).padStart(6)}  ${sentence}`);
console.log('\nListen:  open roundtrip/reply-phone.wav');
