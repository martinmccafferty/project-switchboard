// D-20 waiting-cue audition: each candidate sound fills the real gap from T-009 (3.2 s between
// "One moment, I'll ring the weather bureau." and the answer), plus a version with silence to compare.
// Run from the relay folder after `npm run clips`:  npm run cues
// Writes cues/demo-<cue>-phone.wav (as heard through the handset).
import fs from 'node:fs';
import { operatorSpeaker, SAMPLE_RATE } from './voices.mjs';
import { writeWav, wavToPcm, toPhoneRate, phoneLine, silence, waitingCue, cueNames } from './audio.mjs';

const PHONE_RATE = 16000;
const GAP_MS = 3200;    // measured in T-009
const LEAD_MS = 400;    // pause after the announcement before the cue starts
const ANSWER = "Here in Morrisville it's clear and fifty-eight degrees, heading for a high of sixty-two, "
  + 'while Glasgow is overcast at forty-nine with light drizzle.';

fs.mkdirSync('cues', { recursive: true });
const announcement = wavToPcm(fs.readFileSync('clips/doris/announce-get_weather.wav'));

// The answer is rendered once and reused, so every demo has the identical answer.
if (!fs.existsSync('cues/answer.wav')) {
  const doris = await operatorSpeaker('doris');
  const { pcm } = await doris.speak(ANSWER);
  doris.close();
  writeWav('cues/answer.wav', toPhoneRate(pcm, SAMPLE_RATE, PHONE_RATE), PHONE_RATE);
}
const answer = wavToPcm(fs.readFileSync('cues/answer.wav'));

for (const cue of ['silence', ...cueNames]) {
  const gap = cue === 'silence' ? silence(GAP_MS, PHONE_RATE)
    : Buffer.concat([silence(LEAD_MS, PHONE_RATE), waitingCue(cue, GAP_MS - LEAD_MS, PHONE_RATE)]);
  const pcm = Buffer.concat([announcement, gap, answer, silence(500, PHONE_RATE)]);
  writeWav(`cues/demo-${cue}-phone.wav`, phoneLine(pcm, PHONE_RATE), PHONE_RATE);
  console.log(`cues/demo-${cue}-phone.wav`);
}
console.log('Listen:  open cues');
