// Project Switchboard relay - Phase 2: hello messages + audio-streaming test (test B / T-006).
// Runs on the Mac for development; later deploys to Railway (D-11).
import { WebSocketServer } from 'ws';
import os from 'node:os';
import fs from 'node:fs';

const PORT = Number(process.env.PORT) || 8080;
const SAMPLE_RATE = 16000;
const wss = new WebSocketServer({ port: PORT });
const now = () => new Date().toLocaleTimeString();

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

function writeWav(path, chunks) {
  const data = Buffer.concat(chunks);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path, Buffer.concat([h, data]));
}

function report(test) {
  if (!test) { console.log('No audio was received.'); return; }
  const secs = (test.last - test.start) / 1000 + 0.02;
  const kbps = (test.bytes * 8) / 1000 / secs;
  const avg = test.gaps.reduce((a, b) => a + b, 0) / Math.max(test.gaps.length, 1);
  const worst = test.gaps.length ? Math.max(...test.gaps) : 0;
  const late = test.gaps.filter((g) => g > 60).length;
  writeWav('test-tone.wav', test.chunks);
  console.log(`[${now()}] Audio test complete`);
  console.log(`  Received:      ${test.frames} frames, ${(test.bytes / 1024).toFixed(1)} KB in ${secs.toFixed(1)} s`);
  console.log(`  Data rate:     ${kbps.toFixed(0)} kbit/s (expected 256)`);
  console.log(`  Frame spacing: average ${avg.toFixed(1)} ms (expected 20), worst ${worst} ms`);
  console.log(`  Late frames:   ${late} with a gap over 60 ms (${((100 * late) / Math.max(test.frames, 1)).toFixed(1)}%)`);
  console.log(`  Saved recording: test-tone.wav (in this folder; open it to hear the tone)`);
}

wss.on('connection', (ws, req) => {
  console.log(`[${now()}] Phone connected from ${req.socket.remoteAddress}`);
  ws.send('Hello from the Switchboard relay!');
  let test = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const t = Date.now();
      if (!test) test = { start: t, last: null, frames: 0, bytes: 0, gaps: [], chunks: [] };
      if (test.last !== null) test.gaps.push(t - test.last);
      test.last = t;
      test.frames++;
      test.bytes += data.length;
      test.chunks.push(Buffer.from(data));
      ws.send(data, { binary: true });           // echo audio back to the phone
      return;
    }
    const text = data.toString();
    if (text === 'START') { test = null; console.log(`[${now()}] Audio test started (60 s)...`); return; }
    if (text === 'END') { report(test); test = null; return; }
    console.log(`[${now()}] Phone says: ${text}`);
    ws.send(`Relay heard: ${text}`);
  });

  ws.on('close', () => console.log(`[${now()}] Phone disconnected`));
});

console.log(`Switchboard relay listening on port ${PORT}`);
console.log(`Board should connect to: ${lanAddresses().join(' or ')}  (port ${PORT})`);
