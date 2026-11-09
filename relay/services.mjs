// The exchange's service numbers (D-26, D-27): one list drives dialing, Doris's "put you through" tool and what
// she tells callers. Add a service here when its line is built.
export const SERVICES = [
  { number: '123', id: 'speaking_clock', name: 'the speaking clock',
    about: 'a British-style speaking clock: the exact time every ten seconds with three pips' },
  { number: '234', id: 'weather_line', name: 'the weather line',
    about: "a recorded-style forecast for home: now, tonight and tomorrow" },
  { number: '101', id: 'echo_test', name: 'the echo test line',
    about: 'lets the caller hear their own voice to test the line' },
];

export const serviceNumbers = SERVICES.map((s) => s.number);

// Doris's tool: hand the caller over to a service line once she has finished speaking.
export const connectTool = {
  name: 'connect_call',
  description: 'Put the caller through to one of the exchange\'s service lines. The switchboard says "Right away." '
    + 'for you, so don\'t; after the tool, say a short line ("Putting you through to the speaking clock now.", perhaps with the number as a '
    + 'friendly aside) and '
    + 'the call is handed over as soon as you finish speaking, so say nothing after it. '
    + ` Lines: ${SERVICES.map((s) => `${s.id} (dial ${s.number}): ${s.about}`).join('; ')}.`,
  input_schema: {
    type: 'object',
    properties: { service: { type: 'string', enum: SERVICES.map((s) => s.id) } },
    required: ['service'],
  },
};

// For the persona: what Doris knows about the lines.
export const servicesForPersona = SERVICES.map((s) => `${s.name} on ${s.number.split('').join('-')} (${s.about})`).join('; ');
