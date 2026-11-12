// Joins one Matter device to the bridge (D-48).
//   npm run pair -- 1234-567-8901 "office lamp"
// The code comes from Google Home: the device -> Settings -> Linked Matter apps & services -> Link apps & services
// -> Use pairing code. It works once and only for a few minutes, so run this straight away.
import fs from 'node:fs';
import { openController, pair, names } from './matter.mjs';

const [code, ...name] = process.argv.slice(2);
if (!code || !name.length) { console.log('Usage: npm run pair -- <pairing code> "<name>"'); process.exit(1); }
if (Object.values(names()).some((n) => n.toLowerCase() === name.join(' ').toLowerCase())) {
  console.log(`There is already a light called "${name.join(' ')}". Choose another name.`); process.exit(1);
}

// If the bridge is running, it holds the Matter identity: hand it the code instead (it adds the light at once).
let running = false;
try { const pid = Number(fs.readFileSync(new URL('./data/bridge.pid', import.meta.url), 'utf8')); process.kill(pid, 0); running = true; } catch { /* not running */ }
if (running) {
  console.log('The bridge is running; asking it to join the device (this can take a minute)…');
  try {
    const res = await fetch(`http://127.0.0.1:${Number(process.env.BRIDGE_LOCAL_PORT) || 8765}/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: name.join(' ') }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error);
    console.log(`Joined "${r.name}". Doris and the porter can work it now; Google Home still controls it too.`);
  } catch (err) {
    console.log(`Couldn't join it: ${err.message}`);
    console.log('If the code has expired, get a fresh one from Google Home and run this again.');
    process.exitCode = 1;
  }
  process.exit();
}
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
