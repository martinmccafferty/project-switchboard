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
import { wavToPcm, plugClick, silence } from './audio.mjs';
import { operatorCall } from './call-operator.mjs';
import { speakingClock } from './clock.mjs';
import { weatherCall, prepareWeatherLine } from './weatherline.mjs';
import { handleSettingsApi } from './settings-api.mjs';
import { serviceNumbers } from './services.mjs';
import { dueReminders, markDelivered, markUnanswered, sayWhen } from './reminders.mjs';

const PORT = Number(process.env.PORT) || 8080;
const RATE = 16000;
const FRAME_SAMPLES = 320;                 // 20 ms
const FRAME_BYTES = FRAME_SAMPLES * 2;
const LEAD_MS = 100;                       // how far ahead of real time audio is sent (phone keeps a playout buffer, D-16)
// A number is complete when the caller stops dialing (dial pace varies; the real dial is rotary-style).
// Timings are first guesses, to tune on the real dial in Phase 4.
const KNOWN_NUMBERS = new Set([...serviceNumbers, '911']);                    // grows with the service lines (D-26)
const SETTLE_MS = Number(process.env.SETTLE_MS) || 1500;          // after a known number, if no further digit
const DIAL_TIMEOUT_MS = Number(process.env.DIAL_TIMEOUT_MS) || 3500; // after any other digit
const RING_FOR_MS = Number(process.env.RING_FOR_MS) || 30000; // ring an unanswered reminder this long (five US ring cycles)
const SWITCHING_MS = 500;                  // the exchange's beat of silence before connecting a dialed number (not 0)
const SERVICE_LINES = new Set(['clock', 'weather']); // lines that # or 0 leaves for the operator
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
    this.ws = ws; this.queue = []; this.tone = null; this.toneN = 0; this.filler = null; this.fillerOffset = 0;
    this.sentMs = 0; this.clockStart = Date.now(); this.idle = true;
    this.timer = setInterval(() => this.tick(), 10);
  }
  // Queues 16 kHz PCM; resolves when it has all been sent.
  play(pcm) { return new Promise((resolve) => { this.queue.push({ pcm, offset: 0, resolve }); }); }
  clear() { for (const item of this.queue) item.resolve(); this.queue = []; }
  setTone(name) { this.tone = name ? tones[name] : null; this.toneN = 0; }
  // Background sound looped whenever nothing is queued (the waiting tick, D-20); null to stop.
  setFiller(pcm) { if (pcm !== this.filler) { this.filler = pcm; this.fillerOffset = 0; } }
  nextFrame() {
    // A frame is filled across queued pieces, so live speech arriving in small chunks plays without a sliver of
    // silence at every chunk boundary (padding each chunk's last frame did that, T-025).
    if (this.queue.length) {
      const frame = Buffer.alloc(FRAME_BYTES); let filled = 0;
      while (filled < FRAME_BYTES && this.queue.length) {
        const item = this.queue[0];
        const n = item.pcm.copy(frame, filled, item.offset, item.offset + FRAME_BYTES - filled);
        item.offset += n; filled += n;
        if (item.offset >= item.pcm.length) { this.queue.shift(); item.resolve(); }
      }
      if (filled) return frame;
    }
    if (this.filler) {
      const frame = Buffer.alloc(FRAME_BYTES);
      for (let i = 0; i < FRAME_BYTES; i += 2) {
        frame.writeInt16LE(this.filler.readInt16LE(this.fillerOffset), i);
        this.fillerOffset = (this.fillerOffset + 2) % this.filler.length;
      }
      return frame;
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

// Every connected phone (softphone tabs now, the real phone later).
const lines = new Set();

// One phone line: hook state, dialing, ringing, and what the caller is connected to.
function phoneLine(ws, from) {
  const out = new Outbound(ws);
  let state = 'onhook'; let digits = ''; let dialTimer = null; let connectedTo = null; let call = null; let lineId = 0;
  const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
  const status = (text) => { send({ type: 'status', text }); console.log(`[${now()}] ${from}: ${text}`); };
  let ringing = null; // the reminder this line is ringing for

  // Doris has rung the caller back with a reminder they set (M4).
  function deliverReminder(reminder) {
    state = 'connected'; connectedTo = 'operator'; out.setTone(null);
    status(`Reminder call: ${reminder.message}`);
    call = operatorCall({ out, clips, status, onTransfer: transfer, opening: {
      text: `Hello, this is the operator, ringing with your reminder: ${reminder.message}.`,
      context: `You rang the caller to deliver a reminder they set earlier: "${reminder.message}" (it was due ${sayWhen(reminder.dueAt)}). `
        + "You've already said: \"Hello, this is the operator, ringing with your reminder.\" plus the reminder itself. "
        + 'If they want it again later, set a new reminder; otherwise be brief and let them get on.',
    } });
  }

  async function connect(number) {
    clearTimeout(dialTimer); state = 'connected'; out.setTone(null);
    if (number !== '0') {
      // Like a real exchange: a pause and a faint switching click, so nothing starts over the last key's beep.
      const id = lineId;
      await out.play(Buffer.concat([silence(SWITCHING_MS, RATE), plugClick(RATE)]));
      if (id !== lineId || state !== 'connected') return; // hung up meanwhile
    }
    if (number === '0') {
      connectedTo = 'operator'; status('Operator');
      call = operatorCall({ out, clips, status, onTransfer: transfer });
    } else if (number === '911') {
      connectedTo = 'announcement'; status('911: emergency notice');
      for (let i = 0; i < 2 && state === 'connected'; i++) await out.play(clips.doris['no-emergency']);
    } else if (number === '123') {
      connectedTo = 'clock'; status('Speaking clock (# for the operator)');
      const id = lineId;
      speakingClock({ out, clips, isLive: () => id === lineId && connectedTo === 'clock' })
        .catch((err) => console.log(`Speaking clock failed: ${err.message}`));
    } else if (number === '234') {
      connectedTo = 'weather'; status('Weather line: 1 home, 2 elsewhere, # operator');
      call = weatherCall({ out, clips, log: (t) => status(t) });
    } else if (number === '101') {
      connectedTo = 'echo'; status('Echo test line');
      await out.play(clips.doris['echo-test']);
    } else {
      connectedTo = 'announcement'; status(`${number}: not in service`);
      await out.play(clips.doris['not-in-service']);
    }
  }

  // Doris put the caller through to a service line: her side of the call ends and the exchange connects the number.
  function transfer(number) {
    if (state !== 'connected' || connectedTo !== 'operator') return;
    call?.hangUp(); call = null; connectedTo = null; status(`Operator put the call through to ${number}`);
    connect(number);
  }

  function onDigit(d) {
    // # on a service line (or 0, out of habit): back to the operator (D-27).
    if (state === 'connected' && (d === '#' || d === '0') && SERVICE_LINES.has(connectedTo)) {
      call?.hangUp(); call = null;
      lineId++; out.clear(); connectedTo = null; digits = '0'; status('Back to the operator'); connect('0'); return;
    }
    if (state === 'connected' && connectedTo === 'weather') { call?.onDigit(d); return; }
    if (state === 'offhook') { state = 'dialing'; out.setTone(null); }
    if (state !== 'dialing') return;
    digits += d; status(`Dialed ${digits}`);
    clearTimeout(dialTimer);
    if (digits === '0' || digits.length >= 15) { connect(digits); return; } // 0 = Doris at once (D-17)
    const wait = KNOWN_NUMBERS.has(digits) ? SETTLE_MS : DIAL_TIMEOUT_MS;
    dialTimer = setTimeout(() => state === 'dialing' && connect(digits), wait);
  }

  function hangUp() {
    clearTimeout(dialTimer); call?.hangUp(); call = null; out.clear(); out.setTone(null); out.setFiller(null);
    state = 'onhook'; lineId++; digits = ''; connectedTo = null;
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (data.length !== FRAME_BYTES) return;
      if (connectedTo === 'echo') out.play(Buffer.from(data));
      else if (connectedTo === 'operator' || connectedTo === 'weather') call?.onAudio(Buffer.from(data));
      return;
    }
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'offhook' && state === 'onhook' && ringing) answerRing(line);
    else if (msg.type === 'offhook' && state === 'onhook') { state = 'offhook'; out.setTone('dial'); status('Off hook: dial tone'); }
    else if (msg.type === 'onhook') { hangUp(); status('On hook'); }
    else if (msg.type === 'dial' && typeof msg.digits === 'string') for (const d of msg.digits) if (/[0-9*#]/.test(d)) onDigit(d);
  });
  ws.on('close', () => { lines.delete(line); hangUp(); out.close(); console.log(`[${now()}] ${from}: disconnected`); });

  const line = {
    get idle() { return state === 'onhook' && !ringing && ws.readyState === ws.OPEN; },
    get ringingFor() { return ringing; },
    ring(reminder) { ringing = reminder; send({ type: 'ring' }); status(`RINGING (reminder: ${reminder.message})`); },
    stopRing() { if (ringing) { ringing = null; send({ type: 'stop_ring' }); } },
    answer(reminder) { ringing = null; send({ type: 'stop_ring' }); deliverReminder(reminder); },
  };
  lines.add(line);
}

// --- Reminder ring-back (M4): ring every idle phone; the first to pick up gets Doris.
const ringingNow = new Map(); // reminder id -> { reminder, timer }
function answerRing(line) {
  const reminder = line.ringingFor;
  const entry = ringingNow.get(reminder.id);
  if (!entry) return;
  clearTimeout(entry.timer); ringingNow.delete(reminder.id);
  for (const l of lines) if (l !== line && l.ringingFor?.id === reminder.id) l.stopRing();
  markDelivered(reminder.id);
  line.answer(reminder);
}
setInterval(() => {
  for (const reminder of dueReminders()) {
    if (ringingNow.has(reminder.id)) continue;
    const idle = [...lines].filter((l) => l.idle);
    if (!idle.length) {
      // Every phone is on a call: wait till one hangs up. No phone at all: counts as unanswered.
      if (!lines.size) markUnanswered(reminder.id);
      continue;
    }
    const timer = setTimeout(() => {
      ringingNow.delete(reminder.id);
      for (const l of lines) if (l.ringingFor?.id === reminder.id) l.stopRing();
      markUnanswered(reminder.id);
      console.log(`[${now()}] Reminder "${reminder.message}" not answered`);
    }, RING_FOR_MS);
    ringingNow.set(reminder.id, { reminder, timer });
    for (const l of idle) l.ring(reminder);
  }
}, 1000);

// Static files for the browser softphone.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  // The settings page's API; after a save, the weather menu is re-voiced if the home location changed.
  if (await handleSettingsApi(req, res, { onSaved: () => prepareWeatherLine().catch(() => {}) })) return;
  const name = req.url === '/' ? 'index.html' : req.url.split('?')[0] === '/settings' ? 'settings.html' : path.basename(req.url.split('?')[0]);
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
  prepareWeatherLine().catch((err) => console.log(`Weather menu not voiced yet (${err.message}); first caller will wait`));
  const lan = Object.values(os.networkInterfaces()).flat().filter((a) => a?.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(`Switchboard listening on port ${PORT}`);
  console.log(`  Softphone: http://localhost:${PORT}   (phones on the network: ws://${lan[0] ?? 'this-mac'}:${PORT}/phone)`);
});
