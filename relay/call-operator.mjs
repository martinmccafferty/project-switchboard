// A live call to Doris (M3 step 2): listens for the caller's turn, transcribes it, lets Claude reply as Doris,
// and speaks the reply sentence by sentence. Stored clips cover the instant lines; the clock tick fills waits.
// One instance per call; the exchange (switchboard.mjs) feeds it the caller's audio frames.
import { createOperator } from './operator.mjs';
import { operatorSpeaker, SAMPLE_RATE } from './voices.mjs';
import { StreamResampler, waitingCue, plugClick } from './audio.mjs';
import { createListener } from './listen.mjs';
import { SERVICES, connectTool } from './services.mjs';

const RATE = 16000;
const END_SILENCE_MS = Number(process.env.END_SILENCE_MS) || 800; // quiet that ends the caller's turn
const TICK = waitingCue('clock-tick', 10000, RATE);               // D-20, looped while waiting
const FIRST_CLAUSE = process.env.FIRST_CLAUSE !== 'off';          // start speaking at the first clause
const TICK_FALLBACK_MS = 4000;
// If Claude is still thinking this long after the transcript (limericks took 6-8 s, T-019), Doris says a short
// stored hold line and the tick follows (D-32). Plain replies start within ~1.5 s, so they never hear it.
const HOLD_MS = Number(process.env.HOLD_MS) || 2500;
// Cap on how long the semantic detector may hold after the caller goes quiet (it held ~2.6 s after statements).
const MAX_SILENCE_MS = Number(process.env.MAX_SILENCE_MS) || 1500; // the tick plays during lookups; otherwise only if a plain reply is this slow
const PHONE_BUFFER_MS = 400;
// Nobody has spoken for this long while Doris (or the porter) listens: a stored goodbye, and the line is cleared,
// so a forgotten handset or speakerphone isn't left on for ever (Martin, T-034).
const IDLE_MS = Number(process.env.IDLE_HANGUP_MS) || 60000;
// Titles and abbreviations whose period doesn't end a sentence ("Mrs. Pruitt" was voiced as two pieces with a
// pause between them, T-021). A single capital letter counts too ("J. Edgar").
const NOT_AN_END = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|St|Mt|Jr|Sr|Prof|Rev|Capt|Lt|Col|Gen|Sgt|Gov|Sen|Rep|No|vs|[A-Z])\.$/;
// The first whole sentence at the start of text: { sentence, rest }, or null if none is complete yet.
function takeSentence(text) {
  const end = /[.!?]["')]?\s+/g; let m;
  while ((m = end.exec(text))) {
    const upTo = text.slice(0, m.index + m[0].trimEnd().length);
    if (/\.["')]?$/.test(upTo) && NOT_AN_END.test(upTo.replace(/["')]$/, ''))) continue;
    return { sentence: upTo.trim(), rest: text.slice(m.index + m[0].length) };
  }
  return null;
}
export { takeSentence };                                      // lets the phone finish playing before listening again

// Energy-based turn detection on 20 ms frames, with a slowly adapting noise floor.
// Tells the listener when speech starts (with 300 ms before it), passes each frame, and returns the turn at the end.
class TurnDetector {
  constructor(listener) { this.listener = listener; this.floor = -60; this.reset(); }
  reset() { this.speaking = false; this.run = 0; this.quietMs = 0; this.voicedFrames = 0; this.frames = []; this.preRoll = []; }
  // Returns the caller's utterance (PCM) when a turn ends, else null.
  push(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i += 2) { const v = frame.readInt16LE(i) / 32768; sum += v * v; }
    const db = 10 * Math.log10(sum / (frame.length / 2) + 1e-10);
    const threshold = Math.max(this.floor + 12, -50);
    const voiced = db > threshold;
    if (!this.speaking) {
      this.floor = db < this.floor ? db : this.floor + 0.02 * (db - this.floor);
      this.preRoll.push(frame); if (this.preRoll.length > 15) this.preRoll.shift(); // 300 ms before speech starts
      this.run = voiced ? this.run + 1 : 0;
      if (this.run >= 3) {
        this.speaking = true; this.frames = [...this.preRoll]; this.voicedFrames = 3; this.quietMs = 0;
        this.listener.start(this.frames);
      }
      return null;
    }
    this.frames.push(frame); this.listener.frame(frame);
    if (voiced) { this.voicedFrames++; this.quietMs = 0; } else this.quietMs += 20;
    if (this.quietMs < END_SILENCE_MS && this.frames.length < 1500) return null; // 30 s cap
    const utterance = this.voicedFrames >= 10 ? Buffer.concat(this.frames) : null;   // ignore clicks and coughs
    if (!utterance) this.listener.discard();
    this.reset();
    return utterance;
  }
}

// opening: { text, context } for a call Doris starts herself (delivering a reminder): she says `text` in her
// live voice instead of the greeting clip, and `context` tells Claude what's going on.
import { takeMissed } from './reminders.mjs';
// onTransfer(number): Doris has put the caller through to a service line; the exchange takes over the call.
// line: who answers. Doris by default (Ethel takes over if her voice fails); the 345 home line passes its own
// { name, clipSet, speaker(), agent } (D-40). Clips come from clips[clipSet]: greeting, hold-*, announce-*.
const DORIS = { name: 'Doris', clipSet: 'doris', speaker: () => operatorSpeaker('doris'), failover: 'ethel' };
// onIdle(): nobody spoke for IDLE_MS; the goodbye has played and the exchange disconnects the line.
export function operatorCall({ out, clips, status, opening = null, onTransfer = () => {}, onIdle = () => {}, line = DORIS }) {
  const isDoris = line === DORIS;
  let transferTo = null; // set by connect_call; acted on once Doris has finished speaking
  let active = true; let listening = false;
  // When the caller was last audibly speaking (measured here, for timing what the caller actually waits).
  let lastVoicedAt = 0; let floorDb = -60;
  // Live transcription opens while the greeting plays. In semantic mode it also decides when the caller is done.
  const listener = createListener({ onTurn: (text) => { if (active && listening) handleTurn(async () => ({ text, live: true })); } });
  const detector = new TurnDetector(listener);
  // On an ordinary call, reminders that rang unanswered are mentioned (once) early in the call.
  const missed = opening || !isDoris ? [] : takeMissed();
  const context = opening?.context ?? (missed.length
    ? `These reminders rang while nobody answered. Mention them briefly early in this call: ${missed.map((m) => `"${m.message}" (due ${m.was_due})`).join('; ')}.`
    : '');
  const callTools = { connect_call: { definition: connectTool, run: ({ service }) => {
    const line = SERVICES.find((x) => x.id === service);
    if (!line) return { error: `No service ${service}` };
    transferTo = line.number;
    return { putting_through_to: line.name, number: line.number, note: 'Handed over when you finish speaking.' };
  } } };
  const lineTools = isDoris ? callTools : line.callTools?.({ transferTo: (number) => { transferTo = number; } }) ?? {};
  const operator = createOperator({ context, callTools: lineTools, agent: line.agent,
    onText: (d) => handlers.text(d), onAnnounce: (p, tool) => handlers.announce(p, tool) });
  const handlers = { text: () => {}, announce: () => {} };
  let holdIndex = Math.floor(Math.random() * 3); // rotate the hold lines so the same one doesn't come twice running

  // Doris's voice opens while the greeting plays. If it fails, Ethel takes over the call (D-24).
  let voiceName = line.clipSet;
  let voice = line.speaker().catch((err) => { console.log(`${line.name}'s voice failed to open: ${err.message}`); return null; });
  async function speak(text, onChunk) {
    let streamed = false;
    try {
      const v = await voice;
      if (!v) throw new Error('no voice connection');
      return await v.speak(text, (pcm) => { streamed = true; onChunk(pcm); });
    } catch (err) {
      if (streamed) throw err; // part of the sentence already played; don't repeat it in another voice
      if (!line.failover || voiceName !== line.clipSet) throw err;
      console.log(`Doris's voice failed (${err.message}); Ethel takes over`);
      status('Ethel has taken over the board');
      voiceName = 'ethel';
      (await voice)?.close();
      out.play(clips.ethel.takeover);
      voice = operatorSpeaker('ethel');
      return (await voice).speak(text, onChunk);
    }
  }

  (async () => {
    if (opening) {
      // Doris rang the caller: a plug click, then she speaks first in her live voice.
      await out.play(plugClick(RATE));
      const resampler = new StreamResampler(SAMPLE_RATE, RATE);
      let last = Promise.resolve();
      try { await speak(opening.text, (chunk) => { if (active) last = out.play(resampler.push(chunk)); }); await last; }
      catch (err) { console.log(`Couldn't speak the opening: ${err.message}`); }
    } else {
      await out.play(clips[line.clipSet].greeting);
    }
    if (active) { listening = true; listeningSince = Date.now(); status(`${line.name} is listening`); }
  })();

  let listeningSince = 0;
  const idleCheck = setInterval(async () => {
    if (!active || !listening || Date.now() - listeningSince < IDLE_MS || Date.now() - lastVoicedAt < 3000) return;
    listening = false; clearInterval(idleCheck);
    console.log(`${line.name}: nobody spoke for ${IDLE_MS / 1000} s; clearing the line`);
    const goodbye = clips[voiceName]['idle-goodbye'];
    if (goodbye) await out.play(goodbye);
    if (active) onIdle();
  }, 1000);

  // getTranscript() resolves to { text, live }.
  async function handleTurn(getTranscript) {
    listening = false;
    const t0 = Date.now(); const ms = () => Date.now() - t0;
    const timing = {};
    // How long since the caller's last audible sound, and how long the turn detector held on after it.
    timing.sinceLastWord = lastVoicedAt ? t0 - lastVoicedAt : null;
    timing.detectorHold = lastVoicedAt && listener.speechStoppedAt ? listener.speechStoppedAt - lastVoicedAt : null;
    const tickTimer = setTimeout(() => active && out.setFiller(TICK), TICK_FALLBACK_MS);
    let lastSaid = null; // 'announcement' | 'hold' | 'speech'
    let holdTimer = null;
    let chain = Promise.resolve(); let lastPlay = Promise.resolve();

    // Everything Doris says goes through one ordered chain: render the voice, then queue it on the line.
    const enqueue = (job) => { chain = chain.then(() => (active ? job() : null)); };
    const sayClip = (clip, { thenTick = false } = {}) => enqueue(() => {
      if (!clip) return;
      lastPlay = out.play(clip); timing.firstSound ??= ms();
      if (thenTick) { clearTimeout(tickTimer); out.setFiller(TICK); }
    });
    // Voice audio goes onto the line as it is generated, not after the whole sentence is rendered.
    const saySentence = (text) => { lastSaid = 'speech'; enqueue(async () => {
      const resampler = new StreamResampler(SAMPLE_RATE, RATE);
      await speak(text, (chunk) => {
        if (!active) return;
        if (timing.firstSound === undefined) { clearTimeout(tickTimer); out.setFiller(null); timing.firstSound = ms(); }
        lastPlay = out.play(resampler.push(chunk));
      });
    }); };

    // No "connecting you" in conversation: the caller is already connected to Doris (Martin, T-012). The tool
    // announcements are the "connecting" moments.
    try {
      const { text: heard, live } = await getTranscript();
      timing.heard = ms(); timing.liveTranscript = live;
      if (!active) return;
      if (!heard.trim()) throw new Error('nothing heard');
      status(`Caller: "${heard}"`);
      holdTimer = setTimeout(() => {
        // (A whole reply may already be queued for voicing; that isn't sound yet.)
        if (!active || (line.wholeReply ? timing.firstSound : timing.firstText) !== undefined
          || lastSaid === 'announcement' || lastSaid === 'hold') return;
        const holds = Object.keys(clips[voiceName]).filter((k) => k.startsWith('hold-'));
        if (!holds.length) return;
        lastSaid = 'hold'; timing.hold = ms();
        // Straight onto the line, not into the voicing queue, so it comes before a reply still being voiced.
        lastPlay = out.play(clips[voiceName][holds[holdIndex++ % holds.length]]); timing.firstSound ??= ms();
        clearTimeout(tickTimer); out.setFiller(TICK);
      }, HOLD_MS);

      let pending = '';
      handlers.text = (delta) => {
        timing.firstText ??= ms();
        pending += delta;
        // A voice that is slow to start each piece (Charon, ~1.8 s) speaks the reply whole, at the end (T-032).
        if (line.wholeReply) return;
        clearTimeout(holdTimer);
        let m;
        // The first piece of a reply may end at a comma, semicolon or colon (2+ words) so Doris starts sooner;
        // after that, whole sentences.
        if (timing.firstChunk === undefined && FIRST_CLAUSE && (m = pending.match(/^((?:[^\s.!?]+\s+)+?[^\s.!?]+?[,;:])\s+/s))) {
          timing.firstChunk = ms(); saySentence(m[1].trim()); pending = pending.slice(m[0].length);
        }
        let next;
        while ((next = takeSentence(pending))) {
          timing.firstChunk ??= ms();
          saySentence(next.sentence); pending = next.rest;
        }
      };
      handlers.announce = (phrase, tool) => {
        // Two lookups in a row get one announcement, not two "One moment..."s (nor one after a hold line).
        clearTimeout(holdTimer);
        if (lastSaid === 'announcement' || lastSaid === 'hold') return;
        lastSaid = 'announcement';
        const clip = clips[voiceName][`announce-${tool}`];
        if (clip) sayClip(clip, { thenTick: true });
        else saySentence(phrase);
      };
      const reply = await operator.ask(heard);
      console.log(`${line.name}: "${reply.replace(/\s+/g, ' ').trim()}"`);
      timing.claude = ms();
      if (pending.trim()) saySentence((line.clean ? line.clean(pending) : pending).trim());
      await chain; await lastPlay;
      timing.done = ms();
      const heardAfter = timing.sinceLastWord; // caller's last word -> transcript ready
      console.log(`Turn: last word -> transcript ${heardAfter} ms (detector hold ${timing.detectorHold}) | Claude first words +${timing.firstText} | first sound +${timing.firstSound}${timing.hold ? ` (hold line at +${timing.hold})` : ''} | caller waited ~${heardAfter + timing.firstSound} ms`);
      console.log(`TIMING ${JSON.stringify(timing)}`);
    } catch (err) {
      if (!active) return;
      if (err.message === 'nothing heard') { console.log('Turn: nothing heard'); }
      else {
        console.log(`Turn failed: ${err.message}`);
        await chain.catch(() => {});
        clearTimeout(tickTimer); out.setFiller(null);
        await out.play(clips[line.clipSet]['line-trouble'] ?? clips.doris['line-trouble']);
      }
    } finally {
      clearTimeout(tickTimer); clearTimeout(holdTimer); out.setFiller(null);
      handlers.text = () => {}; handlers.announce = () => {};
    }
    await new Promise((r) => setTimeout(r, PHONE_BUFFER_MS));
    if (active && transferTo) { const number = transferTo; transferTo = null; onTransfer(number); return; }
    if (active) { detector.reset(); listener.resume(); listening = true; listeningSince = Date.now(); status(`${line.name} is listening`); }
  }

  return {
    onAudio(frame) {
      if (!active || !listening) return;
      // Passive level meter (same rule as the detector) to timestamp the caller's last audible sound.
      let sum = 0;
      for (let i = 0; i < frame.length; i += 2) { const v = frame.readInt16LE(i) / 32768; sum += v * v; }
      const db = 10 * Math.log10(sum / (frame.length / 2) + 1e-10);
      if (db > Math.max(floorDb + 12, -50)) lastVoicedAt = Date.now();
      else floorDb = db < floorDb ? db : floorDb + 0.02 * (db - floorDb);
      if (listener.isSemanticLive()) {
        listener.stream(frame);
        if (lastVoicedAt && Date.now() - lastVoicedAt > MAX_SILENCE_MS && listener.forceEnd()) {
          console.log(`Turn ended by the ${MAX_SILENCE_MS} ms silence cap`);
        }
        return;
      }
      // Fallback (or TURN_DETECTION=local): the exchange's own detector finds the end of the turn.
      const utterance = detector.push(frame);
      if (utterance) handleTurn(() => listener.finish(utterance));
    },
    hangUp() {
      active = false; listening = false; clearInterval(idleCheck); out.setFiller(null); listener.close();
      voice.then((v) => v?.close()).catch(() => {});
    },
  };
}
