// Audio helpers: 16-bit mono PCM buffers <-> WAV files, a telephone-line filter, resampling, silence.
import fs from 'node:fs';

export function writeWav(path, pcm, sampleRate) {
  fs.writeFileSync(path, wavBuffer(pcm, sampleRate));
}

export function wavBuffer(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Returns the PCM data of a WAV buffer (skips the RIFF header and any extra chunks).
export function wavToPcm(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF') return wav;
  let i = 12;
  while (i + 8 <= wav.length) {
    const id = wav.toString('ascii', i, i + 4); const size = wav.readUInt32LE(i + 4);
    if (id === 'data') return wav.subarray(i + 8, i + 8 + size);
    i += 8 + size + (size % 2);
  }
  throw new Error('No data chunk in WAV');
}

export const silence = (ms, sampleRate) => Buffer.alloc(Math.round((sampleRate * ms) / 1000) * 2);

const toFloat = (pcm) => Float64Array.from({ length: pcm.length >> 1 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
function toPcm(samples) {
  const out = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  return out;
}

// RBJ biquad filter, applied in place.
function biquad(x, sampleRate, kind, freq, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * freq) / sampleRate; const cos = Math.cos(w); const alpha = Math.sin(w) / (2 * q);
  const b = kind === 'low' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  const a0 = 1 + alpha; const a1 = -2 * cos; const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b[0] * x[i] + b[1] * x1 + b[2] * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
  }
}

// Linear-interpolation resampler (fine for speech after low-pass filtering).
function resample(x, from, to) {
  const n = Math.floor((x.length * to) / from); const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i * from) / to; const j = Math.floor(t); const f = t - j;
    out[i] = x[j] * (1 - f) + (x[Math.min(j + 1, x.length - 1)] ?? 0) * f;
  }
  return out;
}

// What the caller will roughly hear through the handset: telephone band 300–3400 Hz at the phone's 16 kHz.
export function phoneLine(pcm, sampleRate, outRate = 16000) {
  const x = toFloat(pcm);
  for (let k = 0; k < 2; k++) { biquad(x, sampleRate, 'high', 300); biquad(x, sampleRate, 'low', 3400); }
  return toPcm(resample(x, sampleRate, outRate));
}

// The phone streams 16 kHz (brief, T-006): full-band speech for clips, low-passed to avoid aliasing.
export function toPhoneRate(pcm, sampleRate, outRate = 16000) {
  if (sampleRate === outRate) return pcm;
  const x = toFloat(pcm);
  for (let k = 0; k < 2; k++) biquad(x, sampleRate, 'low', outRate * 0.45);
  return toPcm(resample(x, sampleRate, outRate));
}

// --- Synthesized switchboard sounds (no recordings needed). Deterministic, so every build sounds the same.
function random(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 * 2 - 1; };
}

// Adds a mechanical click (filtered noise burst plus a low knock) into x at sample i.
function addClick(x, i, sampleRate, gain, rnd) {
  const burst = new Float64Array(Math.round(sampleRate * 0.03));
  for (let n = 0; n < burst.length; n++) {
    const t = n / sampleRate;
    burst[n] = rnd() * Math.exp(-t / 0.004) + 0.6 * Math.sin(2 * Math.PI * 420 * t) * Math.exp(-t / 0.008);
  }
  biquad(burst, sampleRate, 'high', 300); biquad(burst, sampleRate, 'low', 3500);
  for (let n = 0; n < burst.length && i + n < x.length; n++) x[i + n] += gain * burst[n];
}

// A patch cord going into the board: two quick clicks, the second (seating) softer.
export function plugClick(sampleRate = 16000) {
  const x = new Float64Array(Math.round(sampleRate * 0.25)); const rnd = random(7);
  addClick(x, Math.round(sampleRate * 0.02), sampleRate, 0.55, rnd);
  addClick(x, Math.round(sampleRate * 0.085), sampleRate, 0.3, rnd);
  return toPcm(x);
}

// Waiting cues (D-20): quiet, non-verbal, nothing like a busy or reorder tone.
export const cueNames = ['relay-clicks', 'clock-tick', 'busy-board', 'line-crackle'];
export function waitingCue(name, ms, sampleRate = 16000) {
  const x = new Float64Array(Math.round((sampleRate * ms) / 1000)); const rnd = random(11);
  const at = (sec) => Math.round(sec * sampleRate);
  if (name === 'relay-clicks') {        // a pair of soft relay clicks every 0.9 s
    for (let t = 0; t < ms / 1000; t += 0.9) { addClick(x, at(t), sampleRate, 0.18, rnd); addClick(x, at(t + 0.07), sampleRate, 0.12, rnd); }
  } else if (name === 'clock-tick') {   // a gentle tick-tock, twice a second
    for (let t = 0, k = 0; t < ms / 1000; t += 0.5, k++) {
      for (let n = 0; n < at(0.012) && at(t) + n < x.length; n++) {
        x[at(t) + n] += 0.12 * Math.sin(2 * Math.PI * (k % 2 ? 1600 : 2000) * n / sampleRate) * Math.exp(-n / sampleRate / 0.003);
      }
    }
  } else if (name === 'busy-board') {   // other operators plugging cords in, at irregular moments
    for (let t = 0.1; t < ms / 1000; t += 0.35 + 0.8 * (rnd() + 1) / 2) addClick(x, at(t), sampleRate, 0.08 + 0.08 * (rnd() + 1) / 2, rnd);
  } else if (name === 'line-crackle') { // a faint open-line hiss with the odd crackle
    for (let n = 0; n < x.length; n++) x[n] = 0.012 * rnd();
    biquad(x, sampleRate, 'low', 2500);
    for (let t = 0.2; t < ms / 1000; t += 0.25 + 0.9 * (rnd() + 1) / 2) addClick(x, at(t), sampleRate, 0.05, rnd);
  } else throw new Error(`Unknown cue ${name}`);
  // Fade in and out so the cue never starts or stops with a pop.
  const fade = Math.min(at(0.08), x.length >> 1);
  for (let n = 0; n < fade; n++) { x[n] *= n / fade; x[x.length - 1 - n] *= n / fade; }
  return toPcm(x);
}
