# AI relay

Node.js service that sits between the phone and the AI/smart-home services (D-02).
Development: runs on the Mac. Production: Railway (D-11). Brief: `docs/phase5-relay-brief.md`.

## Setup (once)
1. `cd relay && npm install`
2. `cp .env.example .env`, then open `.env` and paste your Anthropic API key after `ANTHROPIC_API_KEY=`.
   `.env` is git-ignored; never commit it.

## Run
- `npm run chat`: **M1 text operator**: type to the Operator; it can tell the time and the weather.
  Add `-- --show-tools` to see when it calls a tool. Type `bye` to hang up.
- `npm start`: phone WebSocket server (Phase 2 hello + audio test).

## Files
- `operator.mjs`: the Operator: persona, Claude conversation loop, tool calls (one instance per call).
- `tools.mjs`: tool definitions and handlers (time; weather via Open-Meteo, no key needed).
- `chat.mjs`: command-line chat for M1.
- `server.mjs`: phone WebSocket server.
