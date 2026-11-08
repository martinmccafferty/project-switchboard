# Phase 5 brief: the Operator (AI relay)

For Claude Code, or whoever builds the relay. Read `CLAUDE.md` and `docs/engineering-log.md` first.
Decisions referenced: D-02 (thin phone, smart relay), D-11 (Mac for development, Railway for production),
D-13 (direct device APIs, not Google Home), D-16 (jitter buffers), D-17 (pipeline + operator persona), D-18 (OpenAI for speech).

## What we're building
Martin lifts the handset (or presses HANDS FREE) on a vintage-style phone and **dials 0**. A 1950s-style
switchboard operator answers. He talks naturally; the operator can control his smart home, set reminders
(and ring the phone back when they're due), check the weather and look things up.

## Pipeline (D-17, D-18)
phone audio (16 kHz, 16-bit mono PCM over WebSocket) → relay
→ speech-to-text (OpenAI transcription) → **Claude** with tools → reply text
→ text-to-speech (OpenAI TTS, instructed to sound like a warm, crisp 1950s switchboard operator)
→ audio frames back to the phone.

- Stream wherever possible: start TTS on the first complete sentence of Claude's reply.
- Detect end of the caller's turn (voice activity detection plus a short silence) on the relay.
- Phone and relay both keep a ~150–200 ms playout buffer (D-16).
- Model names are configuration, never hard-coded. Pick a current Claude model that balances speed and quality.

## Persona and filler policy
- **Dial 0** → the phone immediately plays a stored clip: switchboard plug sound + "One moment, connecting you…",
  covering connection setup. Then the live operator greets ("Operator. How may I help you?").
- **No scripted filler on later turns.** Only if a reply takes longer than ~1.5 s, play a very short cue (a soft
  click or "Mm-hm"), and cut it off the moment real speech is ready.
- Operator stays in character but stays useful: short spoken answers, no lists or markdown, confirms actions
  ("The living room blinds are closing now.").

## Tools (in build order)
1. Time and date (sanity check).
2. Weather (any free API; location Raleigh/Morrisville NC by default).
3. Reminders: store durably; when due, tell the phone to **ring**; when answered, the operator delivers the reminder.
4. SwitchBot cloud API: Blind Tilt 1–4, Curtain "Curtain 47" (open/close/tilt).
5. Lights (Cync, 15 bulbs): route TBD (Q-11). Start with a stub tool.
6. Web lookup (search tool).

## Phone ↔ relay protocol (first draft; refine as needed)
- Binary frames: raw PCM, 16 kHz, 16-bit little-endian mono, 20 ms (640 bytes).
- Text frames: JSON control messages, e.g. phone → relay `{"type":"offhook"}`, `{"type":"dial","digits":"0"}`,
  `{"type":"onhook"}`; relay → phone `{"type":"ring","pattern":"us"}`, `{"type":"play","clip":"connecting"}`,
  `{"type":"stop_ring"}`.

## Milestones (each must be testable on the Mac before phone hardware arrives)
- **M1 Text operator:** command-line chat with the Claude operator persona and the time/weather tools.
- **M2 Voice round trip with files:** WAV in → transcription → Claude → TTS → WAV out. Audition and tune the operator voice.
- **M3 Browser softphone:** a small web page on the Mac using its microphone and speaker that speaks the *same*
  WebSocket protocol as the phone, so the full voice loop can be used and tuned now.
- **M4 Tools:** reminders with ring-back (softphone shows "RINGING"), SwitchBot blinds.
- **M5 Phone:** connect the real phone once the line module is wired (Phase 4).

## Constraints
- Secrets in `relay/.env` (git-ignored); commit a `.env.example`. Keys: ANTHROPIC_API_KEY, OPENAI_API_KEY, later SWITCHBOT_TOKEN/SECRET.
- Node.js (v24 on Martin's Mac), ES modules, minimal dependencies. Must run unchanged on Railway later.
- Keep `docs/engineering-log.md` updated (tests as T-xxx, decisions as D-xx) and mirror it to the claude.ai Project
  doc if that tool is available; add gotchas to `docs/build-guide-notes.md`.
- Martin is new to electronics but technical; explain steps plainly, one at a time. American spelling.
