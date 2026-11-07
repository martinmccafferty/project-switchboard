// Project Switchboard relay - Phase 2, step 4: hello-world WebSocket server.
// Runs on the Mac for development; later deploys unchanged to Railway (D-11).
import { WebSocketServer } from 'ws';
import os from 'node:os';

const PORT = Number(process.env.PORT) || 8080;
const wss = new WebSocketServer({ port: PORT });
const now = () => new Date().toLocaleTimeString();

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

wss.on('connection', (ws, req) => {
  console.log(`[${now()}] Phone connected from ${req.socket.remoteAddress}`);
  ws.send('Hello from the Switchboard relay!');

  ws.on('message', (data) => {
    const text = data.toString();
    console.log(`[${now()}] Phone says: ${text}`);
    ws.send(`Relay heard: ${text}`);
  });

  ws.on('close', () => console.log(`[${now()}] Phone disconnected`));
});

console.log(`Switchboard relay listening on port ${PORT}`);
console.log(`Board should connect to: ${lanAddresses().join(' or ')}  (port ${PORT})`);
