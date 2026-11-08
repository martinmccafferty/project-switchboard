// Audio helpers: 16-bit mono PCM buffers <-> WAV files, a telephone-line filter, resampling, silence.
import fs from 'node:fs';

export function writeWav(path, pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(path, Buffer.concat([h, pcm]));
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
