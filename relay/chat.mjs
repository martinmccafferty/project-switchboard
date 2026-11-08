// M1 text operator: chat with the Operator from the Mac's command line.
// Run from the relay folder:  npm run chat     (type "bye" or press Ctrl+C to hang up)
import readline from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import { createOperator } from './operator.mjs';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and paste your key in (see README).');
  process.exit(1);
}

const showTools = process.argv.includes('--show-tools');
const operator = createOperator({
  onText: (delta) => process.stdout.write(delta),
  onAnnounce: (phrase) => process.stdout.write(`${phrase} `),
  onTool: (name, input) => showTools && process.stdout.write(`\n  [tool ${name} ${JSON.stringify(input)}]\n  `),
});

console.log(`Switchboard operator (model ${operator.model}, effort ${operator.effort}). Type "bye" to hang up.\n`);
console.log('Operator: Operator. How may I help you?\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('close', () => { console.log('\n*click*'); process.exit(0); });

while (true) {
  const said = (await rl.question('You: ')).trim();
  if (!said) continue;
  if (/^(bye|goodbye|hang up|quit|exit)$/i.test(said)) break;

  process.stdout.write('Operator: ');
  const started = Date.now();
  try {
    await operator.ask(said);
    console.log(`\n  (${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) console.error('\nThe API key was rejected. Check relay/.env.');
    else if (err instanceof Anthropic.RateLimitError) console.error('\nRate limited; wait a moment and try again.');
    else if (err instanceof Anthropic.APIError) console.error(`\nAPI error ${err.status}: ${err.message}`);
    else console.error(`\nError: ${err.message}`);
  }
}
rl.close();
