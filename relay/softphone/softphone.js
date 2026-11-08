// Browser softphone (M3): behaves like the real phone on the relay's /phone line.
const $ = (id) => document.getElementById(id);
const statusEl = $('status'); const hookBtn = $('hook'); const logEl = $('log');
let ws = null; let audio = null; let offHook = false;
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
  ws = new WebSocket(`ws://${location.host}/phone`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { log('Connected to the switchboard'); if (!offHook) setStatus('On hook'); };
  ws.onclose = () => { setStatus('No line (relay not running?)'); setTimeout(connect, 2000); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'status') { setStatus(msg.text); log(msg.text); }
      return;
    }
    stats.in++;
    if (audio && offHook) audio.player.port.postMessage(e.data, [e.data]);
  };
}

// Microphone and speaker, started on the first lift (browsers need a click before audio can start).
async function startAudio() {
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('worklets.js');
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const capture = new AudioWorkletNode(ctx, 'capture');
  const player = new AudioWorkletNode(ctx, 'player');
  ctx.createMediaStreamSource(mic).connect(capture);
  player.connect(ctx.destination);
  capture.port.onmessage = (e) => {
    if (offHook && ws?.readyState === WebSocket.OPEN) { ws.send(e.data); stats.out++; }
  };
  player.port.onmessage = (e) => { $('buffer').textContent = `${e.data.bufferedMs} ms buffered, ${e.data.underruns} gaps`; };
  log(`Audio running at ${ctx.sampleRate} Hz`);
  return { ctx, player };
}

async function toggleHook() {
  if (!offHook) {
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
connect();
