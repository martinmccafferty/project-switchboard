// Audio worklets for the softphone. They run on the browser's audio thread at its own sample rate
// (usually 48 kHz) and convert to and from the phone line's 16 kHz, 20 ms frames.
const LINE_RATE = 16000;
const FRAME = 320; // 20 ms at 16 kHz

// Two-stage low-pass (RBJ biquad) so downsampling doesn't alias.
class LowPass {
  constructor(rate, freq) {
    const w = (2 * Math.PI * freq) / rate; const cos = Math.cos(w); const alpha = Math.sin(w) / Math.SQRT2;
    const a0 = 1 + alpha;
    this.b = [(1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0]; this.a = [-2 * cos / a0, (1 - alpha) / a0];
    this.s = [[0, 0, 0, 0], [0, 0, 0, 0]];
  }
  run(x) {
    for (const s of this.s) {
      const y = this.b[0] * x + this.b[1] * s[0] + this.b[2] * s[1] - this.a[0] * s[2] - this.a[1] * s[3];
      s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y; x = y;
    }
    return x;
  }
}

// Microphone -> 16 kHz Int16 frames posted to the page.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / LINE_RATE; this.pos = 0; this.prev = 0;
    this.lp = new LowPass(sampleRate, 7000);
    this.frame = new Int16Array(FRAME); this.n = 0;
  }
  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;
    for (const raw of input) {
      const x = this.lp.run(raw);
      // Linear interpolation between the previous and current sample at each 16 kHz instant.
      while (this.pos <= 1) {
        const v = this.prev + (x - this.prev) * this.pos;
        this.frame[this.n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        if (this.n === FRAME) { this.port.postMessage(this.frame.buffer, [this.frame.buffer]); this.frame = new Int16Array(FRAME); this.n = 0; }
        this.pos += this.step;
      }
      this.pos -= 1; this.prev = x;
    }
    return true;
  }
}

// 16 kHz Int16 frames from the page -> speaker, through a playout buffer (D-16).
class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(LINE_RATE * 10); this.read = 0; this.write = 0; // ring buffer, 10 s
    this.playing = false; this.pos = 0; this.step = LINE_RATE / sampleRate;
    this.prebuffer = LINE_RATE * 0.15;           // start after 150 ms is buffered...
    this.quietLimit = sampleRate * 0.08; this.sinceData = 0; // ...or when a short sound has fully arrived
    this.underruns = 0; this.lastReport = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'clear') { this.read = this.write = 0; this.playing = false; return; }
      const pcm = new Int16Array(e.data);
      for (const s of pcm) { this.buf[this.write % this.buf.length] = s / 32768; this.write++; }
      this.sinceData = 0;
    };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    const buffered = () => this.write - this.read;
    if (!this.playing && buffered() > 0 && (buffered() >= this.prebuffer || this.sinceData > this.quietLimit)) this.playing = true;
    for (let i = 0; i < out.length; i++) {
      if (this.playing && buffered() >= 2) {
        const a = this.buf[this.read % this.buf.length]; const b = this.buf[(this.read + 1) % this.buf.length];
        out[i] = a + (b - a) * this.pos;
        this.pos += this.step;
        while (this.pos >= 1) { this.pos -= 1; this.read++; }
      } else {
        if (this.playing && buffered() < 2) { this.playing = false; if (this.write > this.read + 0) this.underruns++; this.read = this.write; }
        out[i] = 0;
      }
    }
    this.sinceData += out.length;
    if (currentTime - this.lastReport > 0.5) {
      this.lastReport = currentTime;
      this.port.postMessage({ bufferedMs: Math.round((buffered() / LINE_RATE) * 1000), underruns: this.underruns });
    }
    return true;
  }
}

registerProcessor('capture', Capture);
registerProcessor('player', Player);
