// 345 home line (D-26, D-40): the house porter. Dial 345 (or ask Doris) to work the blinds, curtains and lights (D-48)
// directly: a terse character with only the household's home tools, on a small fast model, in the services'
// voice (Charon, D-35). Same call machinery as Doris (call-operator.mjs); the rooms come from the settings.
// Stored clips:  node --env-file=.env homeline.mjs
import { serviceSpeaker, renderPieces } from './servicevoice.mjs';
import { homeAllForPersona, homeControlsSummary } from './switchbot.mjs';
import { exchangeForPersona } from './services.mjs';

const STYLE = 'A terse, capable British house porter of the 1950s: low, unhurried, polite and brief.';
const MODEL = process.env.HOME_LINE_MODEL || 'claude-haiku-5-5';
const HOME_TOOLS = ['move_blinds', 'blinds_status', 'switch_lights', 'lights_status'];

export const PIECES = {
  greeting: 'Home line. Porter speaking.',
  'hold-1': 'One moment.',
  'announce-move_blinds': 'Very good.',
  'announce-blinds_status': 'Let me look.',
  'announce-switch_lights': 'Very good.',
  'announce-lights_status': 'Let me look.',
  'line-trouble': "Sorry, the home line is out of order just now. Dial zero for the operator.",
  'announce-connect_operator': 'Very good.',
  'idle-goodbye': "I'll clear the line now. Good day.",
};

const persona = () => {
  const rooms = homeAllForPersona();
  return `You are the house porter on the home line, three-four-five, of a household's telephone exchange: a terse,
capable British manservant of the 1950s. Your one job is ${homeControlsSummary() || "the household's controls"}, using your tools.
- You don't know who is calling, so speak to them plainly, without any title or name.
- Everything you say is spoken aloud: a few plain words, no lists or symbols.
- When you move something, the line says "Very good." for you, so just say what you did ("The living room
  blinds are closing."). When you look, it says "Let me look." for you, so go straight to the answer.
- What the rest of the exchange offers: ${exchangeForPersona(homeControlsSummary())} If the caller wants
  something on that list that isn't yours, say in a few words where to get it; if it's on nobody's list, say
  plainly it can't be done from this telephone yet. Never promise what isn't listed, and never suggest someone
  else "may be able to help" with it (T-044: he sent a caller to the operator for colours neither could do).
- To reach the operator they can dial zero or the pound sign (it's a telephone dial: always "dial", never
  "press"), or ask you: then put them through with
  connect_operator, saying a few words first ("Putting you back to the operator.").
- If sincerely asked whether you're a real person, admit briefly, in period voice, that you're a machine.
${rooms || '- Nothing is set up for you to work yet; say the household controls are added on the settings page.'}`;
};

export const homeLine = {
  name: 'Porter',
  clipSet: 'porter',
  speaker: () => serviceSpeaker(STYLE),
  wholeReply: true, // Charon is slow to start each piece, so short replies are voiced whole
  // The butler role pulls the model toward "sir"; telling it not to made it stammer ("sir's— I mean"), so
  // titles are simply taken out before speaking (the caller may be anyone, D-19).
  clean: (text) => text.replace(/^\s*(?:sir|madam|ma'am)\b[,.!?]?\s*/i, '').replace(/,?\s*\b(?:sir|madam|ma'am)\b/gi, '')
    .replace(/\s+([,.!?])/g, '$1').replace(/,([.!?])/g, '$1').replace(/^./, (c) => c.toUpperCase()),
  agent: { system: persona, model: MODEL, effort: null, tools: (all) => all.filter((t) => HOME_TOOLS.includes(t.name)) },
  // The one connection the porter makes: back to the operator (T-033: asked twice, he could only say "press zero").
  callTools: ({ transferTo }) => ({ connect_operator: {
    announce: 'Very good.',
    definition: { name: 'connect_operator', description: 'Put the caller back through to the operator. Say a few words first; '
      + 'the call is handed over when you finish speaking, so say nothing after.', input_schema: { type: 'object', properties: {} } },
    run: () => { transferTo('0'); return { putting_through_to: 'the operator' }; },
  } }),
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await renderPieces('clips/porter', PIECES, STYLE, { all: process.argv.includes('--all') });
}
