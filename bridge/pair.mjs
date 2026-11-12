// Joins one Matter device to the bridge (D-48).
//   npm run pair -- 1234-567-8901 "office lamp"
// The code comes from Google Home: the device -> Settings -> Linked Matter apps & services -> Link apps & services
// -> Use pairing code. It works once and only for a few minutes, so run this straight away.
import { openController, pair } from './matter.mjs';

const [code, ...name] = process.argv.slice(2);
if (!code) { console.log('Usage: npm run pair -- <pairing code> "<name>"'); process.exit(1); }
const controller = await openController();
try {
  console.log('Looking for the device on the home network and joining it (this can take a minute)…');
  const nodeId = await pair(controller, code, name.join(' '));
  console.log(`Joined as node ${nodeId}${name.length ? ` ("${name.join(' ')}")` : ''}. Google Home still controls it too.`);
} catch (err) {
  console.log(`Couldn't join it: ${err.message}`);
  console.log('If the code has expired, get a fresh one from Google Home and run this again.');
  process.exitCode = 1;
} finally {
  await controller.close();
}
