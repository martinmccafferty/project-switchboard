// 235 news line (D-41): "Here is the news, in brief", about sixty seconds read by the services' voice (Charon)
// like a BBC newsreader; then the line disconnects, as a recorded news line would (Martin). The stories come from
// the household's chosen RSS feeds (settings: news.feeds); Claude condenses the latest into a short bulletin in
// its own words. A bulletin is kept 30 minutes, so most callers hear it at once.
// Stored clips:  node --env-file=.env newsline.mjs      Today's bulletin text:  ... newsline.mjs --text
import { settings, DEFAULT_FEEDS } from './settings.mjs';
import { household } from './home.mjs';
import { serviceSpeaker, renderPieces, numberWords } from './servicevoice.mjs';
import { StreamResampler, silence, waitingCue } from './audio.mjs';
import { SAMPLE_RATE } from './voices.mjs';

const RATE = 16000;
const STYLE = 'A calm, authoritative BBC radio newsreader of the 1960s: received pronunciation, measured, clear and neutral.';
const MODEL = process.env.NEWS_MODEL || 'claude-sonnet-5-5';
const KEEP_MS = 30 * 60 * 1000;
const TICK = waitingCue('clock-tick', 10000, RATE); // fills the wait while a fresh bulletin is prepared (D-20)
export const PIECES = {
  intro: 'This is the news line.',
  preparing: 'One moment, while the latest bulletin is prepared.',
  unavailable: "I'm sorry, the news is not available just now.",
};

// --- Stories from the feeds: { source, title, summary, at } for the last day, newest first.
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&(amp|lt|gt|quot|apos|#39|#8217|#8216|#8220|#8221|nbsp);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    '#39': "'", '#8217': "'", '#8216': "'", '#8220': '"', '#8221': '"', nbsp: ' ' })[e]).replace(/\s+/g, ' ').trim();
const tag = (item, name) => decode((new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(item) ?? [])[1] ?? '');
async function stories() {
  const feeds = settings().news?.feeds ?? DEFAULT_FEEDS;
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const lists = await Promise.all(feeds.map(async (f) => {
    try {
      const res = await fetch(f.url, { headers: { 'user-agent': 'Switchboard news line' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = (await res.text()).match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
      return items.slice(0, 10).map((it) => ({ source: f.name, title: tag(it, 'title'), summary: tag(it, 'description').slice(0, 300),
        at: Date.parse(tag(it, 'pubDate')) || null })).filter((s) => s.title && (!s.at || s.at > dayAgo));
    } catch (err) { console.log(`News feed ${f.name} failed: ${err.message}`); return []; }
  }));
  return lists.flat();
}

// "six forty-five in the evening", in the home time zone, to five minutes.
function spokenNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: household().timezone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date()).map((x) => [x.type, Number(x.value)]));
  const m = Math.floor(p.minute / 5) * 5; const h = p.hour;
  const part = h < 12 ? 'in the morning' : h < 18 ? 'in the afternoon' : 'in the evening';
  return `${numberWords(h % 12 || 12)}${m ? ` ${m < 10 ? `oh ${numberWords(m)}` : numberWords(m)}` : " o'clock"} ${part}`;
}

// The bulletin text, written by Claude from the stories.
export async function writeBulletin() {
  const items = await stories();
  if (!items.length) throw new Error('no stories from any feed');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const msg = await new Anthropic().messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' },
    system: 'You write a spoken radio news bulletin for a telephone news line, read by a BBC-style newsreader. '
      + 'From the stories given (headlines and summaries from news feeds), choose the five or six most significant, '
      + 'mixing world, national and local where there are any, and write about 150 words in total: one or two plain '
      + 'sentences per story, in your own words, factual and neutral, attributing claims ("officials say"). Use only '
      + 'what the stories say; add nothing else. It is spoken aloud: no headings, lists, symbols, abbreviations or '
      + 'URLs; numbers and dates written as a newsreader would say them. Begin exactly with the opening line given, '
      + 'and end with "That is the news."',
    messages: [{ role: 'user', content: `Opening line: "Here is the news, in brief, as of ${spokenNow()}."\n\nStories:\n`
      + items.map((s) => `- [${s.source}] ${s.title}. ${s.summary}`).join('\n') }],
  }, { timeout: 30000 });
  if (msg.stop_reason !== 'end_turn') console.log(`News bulletin stopped early (${msg.stop_reason})`);
  // One paragraph: Charon paused ~1.5 s at each paragraph break between stories (T-034).
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/\s*\n+\s*/g, ' ').trim();
}

let kept = null; // { at, pcm } the last voiced bulletin
let making = null; // the bulletin being prepared, shared by callers who arrive meanwhile

// Writes and voices a fresh bulletin, sending audio to onChunk as it is voiced; resolves with all of it.
function freshBulletin(onChunk) {
  making ??= (async () => {
    const text = await writeBulletin();
    const speaker = await serviceSpeaker(STYLE);
    try {
      const resampler = new StreamResampler(SAMPLE_RATE, RATE); const parts = [];
      await speaker.speak(text, (chunk) => { const pcm = resampler.push(chunk); parts.push(pcm); for (const f of listeners) f(pcm); });
      kept = { at: Date.now(), pcm: Buffer.concat(parts) };
      return kept.pcm;
    } finally { speaker.close?.(); making = null; listeners.clear(); }
  })();
  listeners.add(onChunk);
  return making;
}
const listeners = new Set();

// One call to the news line: { onDigit, onAudio, hangUp } (# and 0 are the exchange's). onFinished() runs when
// the bulletin is over, and the exchange disconnects the line.
export function newsCall({ out, clips, log = console.log, onFinished = () => {} }) {
  const n = clips.news; const hint = clips.clock.operator;
  let live = true;
  (async () => {
    await out.play(Buffer.concat([n.intro, silence(400, RATE)]));
    let pcm = kept && Date.now() - kept.at < KEEP_MS ? kept.pcm : null;
    try {
      if (pcm) { if (live) await out.play(pcm); } else {
        if (live) out.play(n.preparing);
        if (live) out.setFiller(TICK);
        let last = Promise.resolve(); let started = false;
        pcm = await freshBulletin((chunk) => {
          if (!live) return;
          if (!started) { started = true; out.setFiller(null); }
          last = out.play(chunk);
        });
        await last;
      }
    } catch (err) {
      // Not available: say so, give the way to the operator a few seconds to be used, then disconnect.
      log(`News line failed: ${err.message}`); out.setFiller(null);
      if (live) await out.play(Buffer.concat([n.unavailable, silence(700, RATE), hint, silence(6000, RATE)]));
      if (live) onFinished();
      return;
    }
    if (live) { await out.play(silence(1200, RATE)); if (live) onFinished(); }
  })();
  return { onDigit() {}, onAudio() {}, hangUp() { live = false; out.setFiller(null); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--text')) { const t0 = Date.now(); const text = await writeBulletin(); console.log(text); console.log(`(${text.split(/\s+/).length} words, written in ${Date.now() - t0} ms)`); }
  else await renderPieces('clips/news', PIECES, STYLE, { all: process.argv.includes('--all') });
}
