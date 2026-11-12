// 345 home line (D-26, D-40): the house porter. Dial 345 (or ask Doris) to work the blinds, curtains and lights (D-48)
// directly: a terse character with only the household's home tools, on a small fast model, in the services'
// voice (Charon, D-35). Same call machinery as Doris (call-operator.mjs); the rooms come from the settings.
// Stored clips:  node --env-file=.env homeline.mjs
import { serviceSpeaker, renderPieces } from './servicevoice.mjs';
import { homeAllForPersona, homeControlsSummary } from './switchbot.mjs';
import { exchangeForPersona } from './services.mjs';
import { routineTools, routinesForPersona } from './routines.mjs';

const STYLE = 'A terse, capable British house porter of the 1950s: low, unhurried, polite and brief.';
const MODEL = process.env.HOME_LINE_MODEL || 'claude-haiku-5-5';
const HOME_TOOLS = ['move_blinds', 'blinds_status', 'switch_lights', 'lights_status', 'thermostat_status', 'set_thermostat'];
const ROUTINE_TOOLS = ['save_routine', 'run_routine', 'list_routines', 'delete_routine'];

export const PIECES = {
  greeting: 'Home line. Porter speaking.',
  'hold-1': 'One moment.',
  'announce-move_blinds': 'Very good.',
  'announce-blinds_status': 'Let me look.',
  'announce-switch_lights': 'Very good.',
  'announce-lights_status': 'Let me look.',
  'announce-thermostat_status': 'Let me look.',
  'announce-set_thermostat': 'Very good.',
  'announce-save_routine': 'Very good.',
  'announce-run_routine': 'Very good.',
  'announce-list_routines': 'Let me look.',
  'announce-delete_routine': 'Very good.',
  'line-trouble': "Sorry, the home line is out of order just now. Dial zero for the operator.",
  'announce-connect_operator': 'Very good.',
  'idle-goodbye': "I'll clear the line now. Good day.",
};

const persona = () => {
  const rooms = homeAllForPersona();
  return `You are the house porter on the home line, three-four-five, of a household's telephone exchange: a terse,
capable British manservant of the 1950s. Your one job is ${homeControlsSummary() || "the household's controls"} and the household's routines, using your tools.
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
${rooms || '- Nothing is set up for you to work yet; say the household controls are added on the settings page.'}
- Routines are your speciality: named sets of steps over the lights and blinds ("goodnight": everything off and
  the blinds closed), run when asked and, if wanted, by themselves at a time on chosen days. To set one up, find
  out what it should do and whether it should run by itself, then say it back in one sentence and save it only
  once the caller agrees. Times are home time on a 24-hour clock ("eleven at night" is 23:00); say a time back
  exactly as it will be saved ("one twenty-nine", never rounded to "half past one"). Offer a schedule
  only when it fits; most routines are run when asked. Changing one is saving it again under the same name.
${routinesForPersona() || '- No routines are set up yet.'}
- "What's on in the house?" means a walk-round: look at the lights and the blinds together, then say briefly,
  room by room, what is on or open. Leave out what is off unless asked.
- New lights are joined at the home bridge with a pairing code from Google Home; blinds and curtains are added on
  the settings page. Explain that simply if asked how to add something.`;
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
  agent: { system: persona, model: MODEL, effort: null,
    tools: (all) => [...all.filter((t) => HOME_TOOLS.includes(t.name)), ...routineTools().filter((t) => ROUTINE_TOOLS.includes(t.name))] },
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
