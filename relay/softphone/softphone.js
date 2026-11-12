// Browser softphone (M3): behaves like the real phone on the relay's /phone line.
const $ = (id) => document.getElementById(id);
const statusEl = $('status'); const hookBtn = $('hook'); const logEl = $('log');
let ws = null; let audio = null; let offHook = false; let ringing = false; let bellTimer = null;
const stats = { out: 0, in: 0 };

function log(text) {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  logEl.prepend(line);
  while (logEl.childElementCount > 40) logEl.lastChild.remove();
}
const setStatus = (text) => { statusEl.textContent = text; };

// The line to the exchange; reconnects by itself if the relay restarts.
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/phone`); // wss when served over https (Railway)
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { log('Connected to the switchboard'); if (!offHook) setStatus('On hook'); };
  ws.onclose = () => { setStatus('No line (relay not running?)'); setTimeout(connect, 2000); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'status') { setStatus(msg.text); log(msg.text); }
      else if (msg.type === 'ring') startRinging();
      else if (msg.type === 'stop_ring') stopRinging();
      return;
    }
    stats.in++;
    if (audio && offHook) audio.player.port.postMessage(e.data, [e.data]);
  };
}

// Speaker opens at page load. Browsers keep it silent until the first click or key press on the page
// (autoplay rule), so the first one anywhere unlocks it; until then a small note says so.
let outputReady = null;
function startOutput() {
  outputReady ??= (async () => {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('worklets.js');
    const player = new AudioWorkletNode(ctx, 'player');
    player.connect(ctx.destination);
    player.port.onmessage = (e) => { $('buffer').textContent = `${e.data.bufferedMs} ms buffered, ${e.data.underruns} gaps`; };
    const showUnlock = () => { $('unlock').hidden = ctx.state === 'running' || !bellOn(); };
    ctx.onstatechange = showUnlock; showUnlock();
    return { ctx, player, bell: makeBell(ctx) };
  })();
  return outputReady;
}
function unlockAudio() { startOutput().then(({ ctx }) => ctx.resume()).catch(() => {}); }

// Bell toggle: on by default; remembered in this browser.
const bellOn = () => $('bell').checked;
try { $('bell').checked = localStorage.getItem('bell') !== 'off'; } catch { /* storage blocked: stay on */ }
$('bell').onchange = () => {
  try { localStorage.setItem('bell', bellOn() ? 'on' : 'off'); } catch { /* not remembered */ }
  startOutput().then(({ ctx }) => { $('unlock').hidden = ctx.state === 'running' || !bellOn(); });
};

async function startAudio() {
  const { ctx, player, bell } = await startOutput();
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const capture = new AudioWorkletNode(ctx, 'capture');
  ctx.createMediaStreamSource(mic).connect(capture);
  capture.port.onmessage = (e) => {
    if (offHook && ws?.readyState === WebSocket.OPEN) { ws.send(e.data); stats.out++; }
  };
  log(`Audio running at ${ctx.sampleRate} Hz`);
  return { ctx, player, bell };
}

// An electromechanical bell: a clapper striking a brass gong 20 times a second, for one 2-second burst.
function makeBell(ctx) {
  const rate = ctx.sampleRate; const buf = ctx.createBuffer(1, rate * 2, rate); const x = buf.getChannelData(0);
  const partials = [[1180, 1], [2870, 0.5], [4130, 0.25]];
  for (let k = 0; k < 40; k++) {                        // strikes every 50 ms
    const start = Math.round(k * 0.05 * rate);
    for (let n = start; n < x.length; n++) {
      const t = (n - start) / rate; const env = Math.exp(-t / 0.18) * 0.06;
      if (env < 0.0005) break;
      for (const [f, a] of partials) x[n] += a * env * Math.sin(2 * Math.PI * f * t);
    }
  }
  return buf;
}

// US ring cadence: 2 seconds on, 4 off, until answered or the exchange stops ringing.
async function startRinging() {
  ringing = true; document.body.classList.add('ringing'); setStatus('RINGING (lift the handset to answer)'); log('Ringing');
  clearInterval(bellTimer);
  const ring = async () => {
    if (!ringing || !bellOn()) return;
    const { ctx, bell } = await startOutput();
    const src = ctx.createBufferSource(); src.buffer = bell; src.connect(ctx.destination); src.start();
  };
  ring(); bellTimer = setInterval(ring, 6000);
}
function stopRinging() {
  ringing = false; clearInterval(bellTimer); document.body.classList.remove('ringing');
}

async function toggleHook() {
  if (!offHook) {
    stopRinging();
    try { audio ??= await startAudio(); } catch (err) { log(`Microphone problem: ${err.message}`); return; }
    await audio.ctx.resume();
    offHook = true; hookBtn.textContent = 'Hang up'; document.body.classList.add('offhook');
    ws.send(JSON.stringify({ type: 'offhook' }));
  } else {
    offHook = false; hookBtn.textContent = 'Lift handset'; document.body.classList.remove('offhook');
    audio?.player.port.postMessage('clear');
    ws.send(JSON.stringify({ type: 'onhook' }));
  }
}

// Key press: a short touch-tone in the earpiece (as the real phone makes), and the digit to the exchange.
const DTMF = { 1: [697, 1209], 2: [697, 1336], 3: [697, 1477], 4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477], '*': [941, 1209], 0: [941, 1336], '#': [941, 1477] };
function press(key) {
  if (!offHook) return;
  const t = audio.ctx.currentTime; const gain = audio.ctx.createGain(); gain.gain.value = 0.08; gain.connect(audio.ctx.destination);
  for (const f of DTMF[key]) { const o = audio.ctx.createOscillator(); o.frequency.value = f; o.connect(gain); o.start(t); o.stop(t + 0.12); }
  ws.send(JSON.stringify({ type: 'dial', digits: key }));
}

hookBtn.onclick = toggleHook;
for (const key of document.querySelectorAll('.key')) key.onclick = () => press(key.dataset.key);
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.key === ' ') { e.preventDefault(); toggleHook(); } else if (DTMF[e.key]) press(e.key);
});
setInterval(() => { $('frames').textContent = `frames sent ${stats.out}, received ${stats.in}`; }, 500);
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, unlockAudio);
startOutput();
connect();

// The shopping list, live (D-58): it changes here as the operator adds and removes things on a call.
const shopping = new EventSource('/api/list/events');
shopping.onmessage = (e) => {
  const list = JSON.parse(e.data);
  const ul = document.getElementById('list-items');
  const sorted = [...list.filter((i) => !i.done), ...list.filter((i) => i.done)];
  ul.replaceChildren(...(sorted.length ? sorted.map((i) => Object.assign(document.createElement('li'), { textContent: i.text, className: i.done ? 'done' : '' }))
    : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'Nothing on the list.' })]));
};
