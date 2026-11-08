// Hearing the caller (M3 step 3): live transcription while they speak, so the words are ready almost as soon
// as they stop. One connection per call, opened while the greeting plays. Falls back to transcribing the
// recorded turn as a file if the live connection has any problem.
import OpenAI, { toFile } from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import { StreamResampler, wavBuffer } from './audio.mjs';

const LIVE_MODEL = process.env.OPENAI_LIVE_STT_MODEL || 'gpt-live-transcribe';
const FILE_MODEL = process.env.OPENAI_STT_MODEL || 'gpt-transcribe';
const LINE_RATE = 16000;
const LIVE_RATE = 24000;           // the Realtime API takes 24 kHz PCM
const RESULT_TIMEOUT_MS = 4000;    // after this, use the file fallback
const KEYWORDS = ['Doris', 'Ethel', 'operator', 'Morrisville', 'switchboard'];
const openai = new OpenAI();

async function transcribeFile(pcm) {
  const { text } = await openai.audio.transcriptions.create({
    file: await toFile(wavBuffer(pcm, LINE_RATE), 'caller.wav'),
    model: FILE_MODEL, prompt: 'A caller speaking to Doris, a telephone switchboard operator.',
  });
  return text;
}

export function createListener() {
  let rt = null; let ready = false; let resampler = null;
  const results = new Map(); // item_id -> transcript
  let waiting = null;        // { itemId, resolve }

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
            transcription: { model: LIVE_MODEL, language: 'en', keywords: KEYWORDS },
            turn_detection: null, // the exchange decides when a turn ends
          } },
        },
      });
      rt.on('conversation.item.input_audio_transcription.completed', (e) => {
        results.set(e.item_id, e.transcript);
        if (waiting && waiting.itemId === e.item_id) waiting.resolve(e.transcript);
      });
      rt.on('input_audio_buffer.committed', (e) => { if (waiting && !waiting.itemId) waiting.itemId = e.item_id; if (waiting && results.has(e.item_id)) waiting.resolve(results.get(e.item_id)); });
      rt.on('error', (err) => { console.log(`Live transcription error: ${err.message ?? err}`); ready = false; });
      rt.socket.on('close', () => { ready = false; });
      ready = true;
    } catch (err) {
      console.log(`Live transcription unavailable (${err.message}); using file transcription`);
      ready = false;
    }
  })();

  const send = (frames) => {
    if (!ready) return;
    for (const f of frames) rt.send({ type: 'input_audio_buffer.append', audio: resampler.push(f).toString('base64') });
  };

  return {
    // The caller started talking: stream the audio from just before that moment onward.
    start(preRoll) { resampler = new StreamResampler(LINE_RATE, LIVE_RATE); if (ready) rt.send({ type: 'input_audio_buffer.clear' }); send(preRoll); },
    frame(f) { send([f]); },
    discard() { if (ready) rt.send({ type: 'input_audio_buffer.clear' }); },
    // The caller finished: returns { text, live } using the live result, or the file fallback.
    async finish(utterance) {
      if (ready) {
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
    close() { try { rt?.close(); } catch { /* already closed */ } },
  };
}
