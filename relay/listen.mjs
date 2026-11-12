// Hearing the caller (M3): live transcription over one Realtime transcription connection per call, opened
// while the greeting plays.
//   semantic (default): the caller's audio streams continuously while Doris listens, and OpenAI's semantic turn
//     detection decides when they've finished, judging from what they're saying, so a hesitation mid-sentence
//     gets more patience than a plain pause (T-014).
//   local: the exchange's own energy detector finds the turn; audio streams only while the caller speaks.
// If the live connection fails, the exchange falls back to its own detector and transcribes the turn as a file.
//
// Faster long turns (D-47): in semantic mode a second connection streams the same audio to gpt-live-transcribe,
// which writes the words out while the caller is still speaking (T-040: the whole of a 13 s statement was there
// before the turn ended). When the turn ends, that text is used as soon as it has settled, instead of waiting
// 0.6-0.9 s for gpt-transcribe to transcribe the turn from the start. gpt-transcribe's text still arrives and is
// used if the streaming text isn't ready first; any difference between the two is logged.
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
const STREAM_MODEL = process.env.OPENAI_STREAM_STT_MODEL || 'gpt-live-transcribe';
const DUAL = process.env.DUAL_TRANSCRIPTION !== '0';          // DUAL_TRANSCRIPTION=0 turns the streaming copy off
// Streaming text counts as settled once no new words have come for SETTLE_QUIET_MS and the caller has been quiet
// for SETTLE_AFTER_VOICE_MS (its last words land 0.6-0.9 s after they're spoken, T-040).
const SETTLE_QUIET_MS = 400;
const SETTLE_AFTER_VOICE_MS = 1000;
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

// Opens one Realtime transcription connection. Resolves to the client once the session is set up.
async function openSession({ model, turnDetection }) {
  const rt = new OpenAIRealtimeWS({ intent: 'transcription' }, openai);
  await new Promise((resolve, reject) => { rt.socket.once('open', resolve); rt.socket.once('error', reject); });
  rt.send({
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: { input: {
        format: { type: 'audio/pcm', rate: LIVE_RATE },
        transcription: { model, language: 'en', keywords: keywords() },
        turn_detection: turnDetection,
      } },
    },
  });
  return rt;
}

// The streaming copy (D-47): text per item as it is written, while the caller speaks. Turns are ended by the
// semantic connection, which then calls take(); the streaming buffer is committed so the next turn starts afresh.
function createStream() {
  let rt = null; let ready = false; let closing = false;
  let resampler = new StreamResampler(LINE_RATE, LIVE_RATE);
  const text = new Map(); let current = null; let lastDeltaAt = 0; const used = new Set();
  (async () => {
    try {
      rt = await openSession({ model: STREAM_MODEL, turnDetection: null });
      rt.on('conversation.item.input_audio_transcription.delta', (e) => {
        if (used.has(e.item_id)) return; // late words from a turn already taken
        text.set(e.item_id, (text.get(e.item_id) ?? '') + e.delta); current = e.item_id; lastDeltaAt = Date.now();
      });
      rt.on('error', (err) => { console.log(`Streaming transcription error: ${err.message ?? err}`); });
      rt.socket.on('close', () => { if (ready && !closing) console.log('Streaming transcription connection lost; using full transcription only'); ready = false; });
      ready = true;
    } catch (err) {
      console.log(`Streaming transcription unavailable (${err.message}); using full transcription only`);
    }
  })();
  const drop = () => { if (current) used.add(current); current = null; };
  return {
    send(f) { if (ready) rt.send({ type: 'input_audio_buffer.append', audio: resampler.push(f).toString('base64') }); },
    // The turn's text if it has settled, else null. quietFor: ms since the caller was last audible.
    settled(quietFor) {
      const t = current && text.get(current)?.trim();
      return t && Date.now() - lastDeltaAt >= SETTLE_QUIET_MS && quietFor >= SETTLE_AFTER_VOICE_MS ? t : null;
    },
    // The turn is over: forget its text and start a new item for the next one.
    endTurn() { drop(); if (ready) rt.send({ type: 'input_audio_buffer.commit' }); resampler = new StreamResampler(LINE_RATE, LIVE_RATE); },
    clear() { drop(); if (ready) rt.send({ type: 'input_audio_buffer.clear' }); resampler = new StreamResampler(LINE_RATE, LIVE_RATE); },
    close() { closing = true; try { rt?.close(); } catch { /* already closed */ } },
  };
}

// onTurn(text) is called in semantic mode when the caller has finished a turn.
// lastVoicedAt(): when the exchange last heard the caller (for knowing when the streaming text has caught up).
export function createListener({ onTurn = () => {}, lastVoicedAt = () => 0 } = {}) {
  let rt = null; let ready = false; let closing = false;
  let resampler = new StreamResampler(LINE_RATE, LIVE_RATE);
  const results = new Map(); // item_id -> transcript (local mode)
  let waiting = null;        // { itemId, resolve } (local mode)
  const semantic = TURN_DETECTION === 'semantic';
  const listener = { speechStoppedAt: null, speechPending: false };
  const stream = semantic && DUAL ? createStream() : null;
  // Per semantic turn (item id): delivered once, by whichever text is ready first.
  const turns = new Map(); // item_id -> { endedAt, delivered: 'stream' | 'full' | null, streamText, timer }

  (async () => {
    try {
      rt = await openSession({ model: LIVE_MODEL, turnDetection: semantic ? { type: 'semantic_vad', eagerness: EAGERNESS } : null });
      rt.on('input_audio_buffer.speech_started', () => { listener.speechPending = true; });
      rt.on('input_audio_buffer.speech_stopped', () => { listener.speechStoppedAt = Date.now(); });
      rt.on('input_audio_buffer.committed', (e) => {
        listener.speechPending = false;
        if (!semantic || !stream) return;
        // The turn has ended: use the streaming text as soon as it has settled (checked every 50 ms).
        const turn = { endedAt: Date.now(), delivered: null, streamText: null, timer: null };
        turns.set(e.item_id, turn);
        const check = () => {
          if (turn.delivered) return;
          const text = stream.settled(Date.now() - lastVoicedAt());
          if (!text) { if (Date.now() - turn.endedAt < 10_000) turn.timer = setTimeout(check, 50); return; }
          turn.delivered = 'stream'; turn.streamText = text; stream.endTurn();
          console.log(`Turn text from streaming ${Date.now() - turn.endedAt} ms after the turn ended: "${text}"`);
          onTurn(text);
        };
        check();
      });
      rt.on('conversation.item.input_audio_transcription.completed', (e) => {
        if (semantic) {
          const after = listener.speechStoppedAt ? Date.now() - listener.speechStoppedAt : null;
          const turn = turns.get(e.item_id); turns.delete(e.item_id);
          if (turn) clearTimeout(turn.timer);
          if (turn?.delivered === 'stream') {
            const same = norm(turn.streamText) === norm(e.transcript);
            console.log(`Full transcription ${Date.now() - turn.endedAt} ms after the turn ended (streaming saved that wait)${same ? '' : `; it heard: "${e.transcript}"`}`);
            return;
          }
          if (turn) { turn.delivered = 'full'; stream?.endTurn(); }
          console.log(`Semantic turn: "${e.transcript}" (${after} ms after speech stopped${turn ? '; streaming text was not ready' : ''})`);
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

  // For comparing the two transcripts: case and punctuation don't count.
  const norm = (t) => (t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const send = (frames) => {
    if (!ready) return;
    for (const f of frames) rt.send({ type: 'input_audio_buffer.append', audio: resampler.push(f).toString('base64') });
  };

  return Object.assign(listener, {
    // True while OpenAI is deciding when turns end (the exchange's own detector then stays out of it).
    isSemanticLive() { return semantic && ready; },
    // Semantic mode: every frame while Doris listens.
    stream(f) { send([f]); stream?.send(f); },
    // The exchange heard enough silence: end the turn now rather than wait for the semantic detector (T-018).
    forceEnd() { if (ready && semantic && listener.speechPending) { listener.speechPending = false; rt.send({ type: 'input_audio_buffer.commit' }); return true; } return false; },
    // Doris is about to listen again: drop anything left over from before.
    resume() {
      listener.speechPending = false; if (ready) rt.send({ type: 'input_audio_buffer.clear' }); resampler = new StreamResampler(LINE_RATE, LIVE_RATE);
      stream?.clear();
    },

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
    close() {
      closing = true; try { rt?.close(); } catch { /* already closed */ }
      stream?.close(); for (const t of turns.values()) clearTimeout(t.timer);
    },
  });
}
