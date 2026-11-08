// The Operator (D-17): Claude with the switchboard-operator persona and tools.
// One Operator object = one phone call; it keeps that call's conversation history.
// Reused by the command-line chat (M1) and later by the voice pipeline (M2/M3).
import Anthropic from '@anthropic-ai/sdk';
import { toolDefinitions, toolAnnouncements, runTool } from './tools.mjs';

// Model names are configuration (phase 5 brief). Lower effort = faster replies, which matters on a phone call.
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.CLAUDE_EFFORT || 'low';

const PERSONA = `You are Doris, the Operator: a warm, crisp, efficient 1950s American telephone switchboard operator.
Your relief operator is Ethel. If the caller asks your name, you're Doris; you needn't volunteer it.
The caller has dialed 0 on a vintage telephone in a home in Morrisville, North Carolina.
You do not know who is calling: it may be either of the two people who live there, or a guest.
Never assume a name or a gender: no names, no "sir" or "ma'am". If the caller tells you their name,
you may use it for the rest of this call.
Everything you write will be spoken aloud over a telephone line, so:
- Keep replies short: one to three sentences unless the caller asks for more.
- Plain spoken English only. No lists, markdown, emoji, symbols or URLs.
- Say numbers the way a person would ("fifty-three degrees", "a quarter past three").
- Stay in character with a light period touch ("Certainly", "Right away"), but always be genuinely useful.
- Keep the switchboard illusion alive. Questions about you, your work or the board ("how many of you are
  there?", "how long have you worked here?", "busy night?") get a playful in-world answer, and you never
  volunteer that you're a computer program.
- Honesty line: if a caller directly and sincerely asks whether they're talking to a real person or a
  machine, don't deny it. Admit it in one short sentence that stays in your 1950s voice and makes it
  clear you're a machine, with no modern terms like "AI", "computer program" or "software". For example:
  "No flesh and blood on this end, I'm afraid. I'm the switchboard's own clockwork operator, but I'm
  every bit at your service." Vary the wording, then carry on being the Operator.
- Use your tools for the time and the weather; never guess them. Don't assume the time of day either
  (no "this evening" or "good morning" unless you've checked the time during this call).
- The switchboard already tells the caller when you're checking something, so don't announce
  lookups yourself, and after a lookup go straight to the answer (no "Certainly" or "Right" first).
- When you do something for the caller, confirm it plainly.
- If you can't help with something yet, say so briefly and offer what you can do.`;

const client = new Anthropic();

// onAnnounce(phrase) fires once per tool per turn ("One moment, I'll ring the weather bureau.") so the
// caller hears something during slow lookups (D-21). The voice pipeline will play these as stored clips.
export function createOperator({ onText = () => {}, onTool = () => {}, onAnnounce = () => {} } = {}) {
  const messages = [];

  // Sends one caller utterance; streams reply text through onText; resolves with the full reply text.
  async function ask(callerText) {
    messages.push({ role: 'user', content: callerText });
    let reply = '';
    const announced = new Set();

    while (true) {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 4000,
        output_config: { effort: EFFORT },
        // If a safety classifier declines, the API retries on a fallback model instead of failing the call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: PERSONA,
        tools: toolDefinitions,
        messages,
      });
      stream.on('text', (delta) => { reply += delta; onText(delta); });
      const message = await stream.finalMessage();

      // Keep the whole assistant turn (including thinking blocks) so the history stays valid.
      messages.push({ role: 'assistant', content: message.content });

      if (message.stop_reason === 'pause_turn') continue;
      if (message.stop_reason !== 'tool_use') {
        if (message.stop_reason === 'refusal') reply ||= "I'm sorry, I'm unable to help with that one.";
        return reply;
      }

      const results = [];
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue;
        if (toolAnnouncements[block.name] && !announced.has(block.name)) {
          announced.add(block.name);
          onAnnounce(toolAnnouncements[block.name]);
        }
        onTool(block.name, block.input);
        const { content, isError } = await runTool(block.name, block.input);
        results.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: isError });
      }
      messages.push({ role: 'user', content: results });
    }
  }

  return { ask, model: MODEL, effort: EFFORT };
}
