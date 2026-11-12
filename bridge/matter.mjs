// The home bridge's Matter controller (D-48), on matter.js. It joins devices as an extra admin through Matter's
// multi-admin sharing: Google Home stays in charge of them and keeps working. What the bridge has joined, and its
// own Matter identity, are kept in data/ (git-ignored; never share it: it is the key to the joined devices).
import fs from 'node:fs';
import path from 'node:path';
import { Environment, Logger, LogLevel } from '@matter/main';
import { GeneralCommissioning } from '@matter/main/clusters';
import { ManualPairingCodeCodec, NodeId } from '@matter/main/types';
import { CommissioningController } from '@project-chip/matter.js';
import '@matter/nodejs';

const DATA = path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const NAMES = path.join(DATA, 'devices.json'); // node id -> the household's name for it
Logger.level = LogLevel.WARN;

const environment = Environment.default;
environment.vars.set('storage.path', DATA);

export const names = () => { try { return JSON.parse(fs.readFileSync(NAMES, 'utf8')); } catch { return {}; } };
const saveNames = (n) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(NAMES, JSON.stringify(n, null, 2) + '\n'); };

export async function openController() {
  const controller = new CommissioningController({
    environment: { environment, id: 'switchboard-bridge' },
    autoConnect: false,
    adminFabricLabel: 'Switchboard',
  });
  await controller.start();
  return controller;
}

// Joins one device using the 11-digit code Google Home shows under "Linked Matter apps & services".
export async function pair(controller, code, name) {
  const { shortDiscriminator, passcode } = ManualPairingCodeCodec.decode(code.replace(/[^0-9]/g, ''));
  const nodeId = await controller.commissionNode({
    commissioning: { regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor, regulatoryCountryCode: 'US' },
    discovery: { identifierData: { shortDiscriminator }, discoveryCapabilities: { onIpNetwork: true } },
    passcode,
  });
  const n = names(); n[String(nodeId)] = name || `device ${nodeId}`; saveNames(n);
  return nodeId;
}

// A joined device by its name (or node id), connected and ready.
export async function device(controller, which) {
  const n = names();
  const id = Object.keys(n).find((k) => n[k].toLowerCase() === String(which).toLowerCase()) ?? String(which);
  if (!controller.getCommissionedNodes().map(String).includes(id)) throw new Error(`No joined device called "${which}". Joined: ${Object.values(n).join(', ') || 'none'}`);
  const node = await controller.getNode(NodeId(BigInt(id)));
  if (!node.isConnected) node.connect();
  if (!node.initialized) await node.events.initialized;
  return { node, name: n[id] ?? id };
}
