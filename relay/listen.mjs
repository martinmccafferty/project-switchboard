// Hearing the caller (M3): live transcription over one Realtime transcription connection per call, opened
// while the greeting plays.
//   semantic (default): the caller's audio streams continuously while Doris listens, and OpenAI's semantic turn
//     detection decides when they've finished, judging from what they're saying, so a hesitation mid-sentence
//     gets more patience than a plain pause (T-014).
//   local: the exchange's own energy detector finds the turn; audio streams only while the caller speaks.
// If the live connection fails, the exchange falls back to its own detector and transcribes the turn as a file.
import OpenAI, { toFile } from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import { StreamResampler, wavBuffer } from './audio.mjs';
import { household } from './home.mjs';

const FILE_MODEL = process.env.OPENAI_STT_MODEL || 'gpt-transcribe';
const TURN_DETECTION = process.env.TURN_DETECTION || 'semantic';   // 'semantic' | 'local'
// gpt-live-transcribe rejects turn detection (T-015), so semantic mode transcribes live with gpt-transcribe.
const LIVE_MODEL = process.env.OPENAI_LIVE_STT_MODEL || (TURN_DETECTION === 'semantic' ? 'gpt-transcribe' : 'gpt-live-transcribe');
const EAGERNESS = process.env.TURN_EAGERNESS || 'high';            // semantic: high waits at most ~2 s; auto 4 s; low 8 s (T-016)
const LINE_RATE = 16000;
const LIVE_RATE = 24000;           // the Realtime API takes 24 kHz PCM
const RESULT_TIMEOUT_MS = 4000;    // local mode: after this, use the file fallback
// Words the transcriber should expect (T-019: "Greenock" came through as "Greenup"): the switchboard's own names,
// the home location, and the household's own list (settings: household.transcribeKeywords). Read per call.
const keywords = () => {
  const h = household();
  return ['Doris', 'Ethel', 'Mrs. Pruitt', 'Buttons', 'operator', 'switchboard', 'limerick',
    ...h.name.split(',').map((k) => k.trim()).filter(Boolean), ...h.keywords];
};
const openai = new OpenAI();

async function transcribeFile(pcm) {
  const { text } = await openai.audio.transcriptions.create({
    file: await toFile(wavBuffer(pcm, LINE_RATE), 'caller.wav'),
    model: FILE_MODEL, prompt: `A caller speaking to Doris, a telephone switchboard operator. Names that may come up: ${keywords().join(', ')}.`,
  });
  return text;
}

// onTurn(text) is called in semantic mode when the caller has finished a turn.
export function createListener({ onTurn = () => {} } = {}) {
  let rt = null; let ready = false; let closing = false;
  let resampler = new StreamResampler(LINE_RATE, LIVE_RATE);
  const results = new Map(); // item_id -> transcript (local mode)
  let waiting = null;        // { itemId, resolve } (local mode)
  const semantic = TURN_DETECTION === 'semantic';
  const listener = { speechStoppedAt: null, speechPending: false };

  (async () => {
    try {
      rt = new OpenAIRealtimeWS({ intent: 'transcription' }, openai);
      await new Promise((resolve, reject) => { rt.socket.once('open', resolve); rt.socket.once('error', reject); });
      rt.send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: { input: {
            format: { type: 'audio/pcm', rate: LIVE_RATE },
            transcription: { model: LIVE_MODEL, language: 'en', keywords: keywords() },
            turn_detection: semantic ? { type: 'semantic_vad', eagerness: EAGERNESS } : null,
          } },
        },
      });
      rt.on('input_audio_buffer.speech_started', () => { listener.speechPending = true; });
      rt.on('input_audio_buffer.speech_stopped', () => { listener.speechStoppedAt = Date.now(); });
      rt.on('input_audio_buffer.committed', () => { listener.speechPending = false; });
      rt.on('conversation.item.input_audio_transcription.completed', (e) => {
        if (semantic) {
          const after = listener.speechStoppedAt ? Date.now() - listener.speechStoppedAt : null;
          console.log(`Semantic turn: "${e.transcript}" (${after} ms after speech stopped)`);
          if (e.transcript.trim()) onTurn(e.transcript);
          return;
        }
        results.set(e.item_id, e.transcript);
        if (waiting && waiting.itemId === e.item_id) waiting.resolve(e.transcript);
      });
      rt.on('input_audio_buffer.committed', (e) => {
        if (semantic || !waiting) return;
        waiting.itemId ??= e.item_id;
        if (results.has(e.item_id)) waiting.resolve(results.get(e.item_id));
      });
      rt.on('error', (err) => { console.log(`Live transcription error: ${err.message ?? err}`); });
      rt.socket.on('close', () => { if (ready && !closing) console.log('Live transcription connection lost; using the exchange\'s own detector'); ready = false; });
      ready = true;
    } catch (err) {
      console.log(`Live transcription unavailable (${err.message}); using the exchange's own detector`);
      ready = false;
    }
  })();

  const send = (frames) => {
    if (!ready) return;
    for (const f of frames) rt.send({ type: 'input_audio_buffer.append', audio: resampler.push(f).toString('base64') });
  };

  return Object.assign(listener, {
    // True while OpenAI is deciding when turns end (the exchange's own detector then stays out of it).
    isSemanticLive() { return semantic && ready; },
    // Semantic mode: every frame while Doris listens.
    stream(f) { send([f]); },
    // The exchange heard enough silence: end the turn now rather than wait for the semantic detector (T-018).
    forceEnd() { if (ready && semantic && listener.speechPending) { listener.speechPending = false; rt.send({ type: 'input_audio_buffer.commit' }); return true; } return false; },
    // Doris is about to listen again: drop anything left over from before.
    resume() { listener.speechPending = false; if (ready) rt.send({ type: 'input_audio_buffer.clear' }); resampler = new StreamResampler(LINE_RATE, LIVE_RATE); },

    // Local mode (and fallback), driven by the exchange's own detector:
    start(preRoll) { if (semantic) return; resampler = new StreamResampler(LINE_RATE, LIVE_RATE); if (ready) rt.send({ type: 'input_audio_buffer.clear' }); send(preRoll); },
    frame(f) { if (!semantic) send([f]); },
    discard() { if (ready && !semantic) rt.send({ type: 'input_audio_buffer.clear' }); },
    // The caller finished (local detector): returns { text, live } from the live result, or the file fallback.
    async finish(utterance) {
      if (ready && !semantic) {
        try {
          const text = await new Promise((resolve, reject) => {
            waiting = { itemId: null, resolve };
            rt.send({ type: 'input_audio_buffer.commit' });
            setTimeout(() => reject(new Error('live transcript timed out')), RESULT_TIMEOUT_MS);
          });
          return { text, live: true };
        } catch (err) {
          console.log(`${err.message}; falling back to file transcription`);
        } finally { waiting = null; }
      }
      return { text: await transcribeFile(utterance), live: false };
    },
    close() { closing = true; try { rt?.close(); } catch { /* already closed */ } },
  });
}
