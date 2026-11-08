// The exchange (M3): one WebSocket "phone line" per connected phone, speaking the phone protocol from the
// Phase 5 brief. The browser softphone uses it now; the ESP32 phone will use the same /phone endpoint later.
//   phone -> relay  binary: 16 kHz 16-bit mono PCM, 20 ms frames | text: {"type":"offhook"|"onhook"} {"type":"dial","digits":"0"}
//   relay -> phone  binary: same PCM format                      | text: {"type":"status","text":...}
// Run from the relay folder:  npm run switchboard   then open http://localhost:8080
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { wavToPcm } from './audio.mjs';

const PORT = Number(process.env.PORT) || 8080;
const RATE = 16000;
const FRAME_SAMPLES = 320;                 // 20 ms
const FRAME_BYTES = FRAME_SAMPLES * 2;
const LEAD_MS = 100;                       // how far ahead of real time audio is sent (phone keeps a playout buffer, D-16)
const DIAL_TIMEOUT_MS = 5000;              // gap after a digit before a short number is given up on
const now = () => new Date().toLocaleTimeString();

// Stored clips (npm run clips), loaded once: clips.doris.greeting etc.
const clips = {};
for (const op of fs.readdirSync('clips', { withFileTypes: true }).filter((d) => d.isDirectory())) {
  clips[op.name] = {};
  for (const f of fs.readdirSync(`clips/${op.name}`).filter((f) => f.endsWith('.wav'))) {
    clips[op.name][f.replace('.wav', '')] = wavToPcm(fs.readFileSync(`clips/${op.name}/${f}`));
  }
}

// US call-progress tones as sample generators.
const tones = {
  dial: (n) => 0.25 * (Math.sin(2 * Math.PI * 350 * n / RATE) + Math.sin(2 * Math.PI * 440 * n / RATE)) / 2,
};

// Sends audio to one phone at real-time pace: queued clips/speech first, otherwise a tone, otherwise nothing.
class Outbound {
  constructor(ws) {
    this.ws = ws; this.queue = []; this.tone = null; this.toneN = 0;
    this.sentMs = 0; this.clockStart = Date.now(); this.idle = true;
    this.timer = setInterval(() => this.tick(), 10);
  }
  // Queues 16 kHz PCM; resolves when it has all been sent.
  play(pcm) { return new Promise((resolve) => { this.queue.push({ pcm, offset: 0, resolve }); }); }
  clear() { for (const item of this.queue) item.resolve(); this.queue = []; }
  setTone(name) { this.tone = name ? tones[name] : null; this.toneN = 0; }
  nextFrame() {
    while (this.queue.length) {
      const item = this.queue[0];
      if (item.offset < item.pcm.length) {
        const frame = Buffer.alloc(FRAME_BYTES);
        item.pcm.copy(frame, 0, item.offset, item.offset + FRAME_BYTES);
        item.offset += FRAME_BYTES;
        return frame;
      }
      this.queue.shift(); item.resolve();
    }
    if (!this.tone) return null;
    const frame = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_SAMPLES; i++) frame.writeInt16LE(Math.round(this.tone(this.toneN++) * 32767), i * 2);
    return frame;
  }
  tick() {
    const elapsed = Date.now() - this.clockStart;
    if (this.idle) this.sentMs = elapsed;    // nothing was playing: don't build up a backlog
    while (this.sentMs < elapsed + LEAD_MS) {
      const frame = this.nextFrame();
      if (!frame) { this.idle = true; return; }
      this.idle = false;
      if (this.ws.readyState === this.ws.OPEN) this.ws.send(frame, { binary: true });
      this.sentMs += 20;
    }
  }
  close() { clearInterval(this.timer); this.clear(); }
}

// One phone line: hook state, dialing, and what the caller is connected to.
function phoneLine(ws, from) {
  const out = new Outbound(ws);
  let state = 'onhook'; let digits = ''; let dialTimer = null; let connectedTo = null;
  const status = (text) => { ws.send(JSON.stringify({ type: 'status', text })); console.log(`[${now()}] ${from}: ${text}`); };

  async function connect(number) {
    clearTimeout(dialTimer); state = 'connected'; out.setTone(null);
    if (number === '0') {
      connectedTo = 'operator'; status('Operator');
      await out.play(clips.doris.greeting);
      // Live conversation with Doris comes in the next M3 step.
    } else if (number === '911') {
      connectedTo = 'announcement'; status('911: emergency notice');
      for (let i = 0; i < 2 && state === 'connected'; i++) await out.play(clips.doris['no-emergency']);
    } else if (number === '101') {
      connectedTo = 'echo'; status('Echo test line');
      await out.play(clips.doris['echo-test']);
    } else {
      connectedTo = 'announcement'; status(`${number}: not in service`);
      await out.play(clips.doris['not-in-service']);
    }
  }

  function onDigit(d) {
    if (state === 'offhook') { state = 'dialing'; out.setTone(null); }
    if (state !== 'dialing') return;
    digits += d; status(`Dialed ${digits}`);
    clearTimeout(dialTimer);
    if (digits === '0' || digits.length === 3) connect(digits);
    else dialTimer = setTimeout(() => state === 'dialing' && connect(digits), DIAL_TIMEOUT_MS);
  }

  function hangUp() {
    clearTimeout(dialTimer); out.clear(); out.setTone(null);
    state = 'onhook'; digits = ''; connectedTo = null;
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (connectedTo === 'echo' && data.length === FRAME_BYTES) out.play(Buffer.from(data));
      return;
    }
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'offhook' && state === 'onhook') { state = 'offhook'; out.setTone('dial'); status('Off hook: dial tone'); }
    else if (msg.type === 'onhook') { hangUp(); status('On hook'); }
    else if (msg.type === 'dial' && typeof msg.digits === 'string') for (const d of msg.digits) if (/[0-9*#]/.test(d)) onDigit(d);
  });
  ws.on('close', () => { hangUp(); out.close(); console.log(`[${now()}] ${from}: disconnected`); });
}

// Static files for the browser softphone.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const name = req.url === '/' ? 'index.html' : path.basename(req.url.split('?')[0]);
  const file = path.join('softphone', name);
  if (!fs.existsSync(file)) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ server, path: '/phone' });
wss.on('connection', (ws, req) => {
  const from = req.socket.remoteAddress.replace('::ffff:', '');
  console.log(`[${now()}] Phone connected from ${from}`);
  phoneLine(ws, from);
});
server.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter((a) => a?.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(`Switchboard listening on port ${PORT}`);
  console.log(`  Softphone: http://localhost:${PORT}   (phones on the network: ws://${lan[0] ?? 'this-mac'}:${PORT}/phone)`);
});
