// Switches a joined light from the Mac (D-48, step 1).
//   npm run light -- "office lamp" on | off | toggle | status | dim 30
import { OnOff, LevelControl } from '@matter/main/clusters';
import { openController, device, names } from './matter.mjs';

const [which, action = 'status', value] = process.argv.slice(2);
if (!which) { console.log(`Usage: npm run light -- "<name>" on|off|toggle|status|dim <percent>\nJoined: ${Object.values(names()).join(', ') || 'none'}`); process.exit(1); }
const controller = await openController();
try {
  const { node, name } = await device(controller, which);
  const lamp = node.getDevices().find((d) => d.getClusterClient(OnOff.Complete));
  if (!lamp) throw new Error(`${name} has no on/off control`);
  const onOff = lamp.getClusterClient(OnOff.Complete);
  const level = lamp.getClusterClient(LevelControl.Complete);
  if (action === 'on') await onOff.on();
  else if (action === 'off') await onOff.off();
  else if (action === 'toggle') await onOff.toggle();
  else if (action === 'dim') {
    if (!level) throw new Error(`${name} can't be dimmed`);
    const pct = Math.max(1, Math.min(100, Number(value)));
    await level.moveToLevelWithOnOff({ level: Math.round(pct * 2.54), transitionTime: 5, optionsMask: {}, optionsOverride: {} });
  } else if (action !== 'status') throw new Error(`Unknown action "${action}"`);
  const on = await onOff.getOnOffAttribute(true);
  const lv = level ? await level.getCurrentLevelAttribute(true) : null;
  console.log(`${name}: ${on ? 'on' : 'off'}${lv != null ? `, brightness ${Math.round(lv / 2.54)}%` : ''}`);
} catch (err) {
  console.log(`Couldn't do that: ${err.message}`);
  process.exitCode = 1;
} finally {
  await controller.close();
}
