# Project Switchboard — Engineering Log

**Owner:** Martin McCafferty · **Engineering partner:** Claude
**Last updated:** 2026-11-07 (Log v1.31)
**Current phase:** Phase 0 — Identification & documentation

> How to use this log: it is the single source of truth between conversations. Claude updates it after every session that produces a discovery, decision, or test result. Items are numbered (C = confirmed, H = hypothesis, D = decision, Q = open question, T = test) so they can be referenced in conversation ("H-01 is now confirmed by T-003").
>
> Two copies are kept in sync: this file in the GitHub repo (`docs/engineering-log.md`, version history) and the Project Switchboard doc on claude.ai (`claude/switchboard-engineering-log.md`, read automatically by new chats).

---

## 1. Status summary

- Telephone opened, photographed, and reassembled. No electrical measurements yet.
- Architecture direction "Build the phone line, not a new phone" accepted in principle (D-01). Final commitment happens at the Phase 3 decision gate.
- GitHub repository `martinmccafferty/project-switchboard` created (private) and seeded (D-07).
- **Phase 0 complete** (photo survey done; nothing found that challenges D-01). Phase 1 closed (D-08). **Phase 2 in progress:** step 1 (install IDE + ESP32 core) done; step 2 (first upload, `00-blink`) **passed** (T-002). Step 3 (Wi-Fi, `01-wifi`) **passed** (T-003). Relay hosting decided (D-11). Next: step 4 = first round-trip message between the board and a relay on the Mac (T-004 and T-005 **passed**: board and relay talk over a persistent connection). Remaining Phase 2 item: audio-streaming throughput test (can run while Phase 3 parts ship). **Phase 3:** architecture committed (D-01); shopping list at `docs/phase3-shopping-list.md` (DigiKey: 2 × AG1171 + small parts, ~$25); codec deferred (D-14). AG1171 backordered at DigiKey and Newark (deliveries from Jan 2027); **Ordered 2026-11-07:** 2 × AG1171S from Symmetry (order #299683) and support parts from DigiKey (section 4.5). Awaiting delivery. Phase 2 audio-streaming test (T-006) passed on throughput; jitter handled by D-16. Phase 2 audio-streaming test (T-006) passed on throughput; jitter handled by D-16.

---

## 2. Goal and constraints

**Goal:** Turn a TelPal 301-Ivory retro telephone into a Wi-Fi AI telephone and smart-home interface that still feels like a genuine old-fashioned phone.

**Target experience (stated 2026-11-07):** dial **0** to reach the AI "operator"; ask it to turn lights on, close the blinds, set a reminder, and have the phone **ring back** when the reminder is due. Smart-home control is a core requirement, not optional.

**Constraints (from Martin):**
- Solder-free if at all possible; reversible modifications.
- Externally unchanged apart from a discreet USB power cable.
- **Portable:** must work anywhere with Wi-Fi and internet, not only at home (added 2026-11-07).
- Wi-Fi only (no Ethernet).
- Minimal cost and minimal extra hardware; no purchases without a clear engineering reason.
- Preserve original components (dial, bell, handset, speaker, hands-free button) wherever practical.
- Work in small, validated steps; no wiring until each previous step is confirmed.

---

## 3. Architecture

### 3.1 Current direction (D-01): "Build the phone line, not a new phone"

The telephone already handles dialing, hands-free, ringing, and handset audio. It only lacks a telephone exchange. The ESP32 becomes a one-line exchange; the phone stays completely stock and plugs in through its own RJ11 line jack.

```
[Unmodified TelPal] --RJ11--> [Line module (SLIC, e.g. Silvertel AG1171)] <-> [I2S audio codec] <-> [ESP32-S3]
                                                                                     |
                                                                                   Wi-Fi
                                                                                     v
                                                                   [AI relay service] <-> [speech + LLM services]
                                                                                     |
                                                                                     +--> smart home (Google Home)
```

| Function | How it is delivered |
|---|---|
| Phone power | Line module generates line voltage from 5 V USB |
| Bell | Line module generates a real ringing signal (rated ~1 REN — to be tested, H-04) |
| Dial | ESP32 decodes the phone's own touch tones (DTMF) in software |
| Hook / hands-free | Both appear to the ESP32 as "off-hook" via the module's switch-hook output |
| Audio | Codec converts line audio to/from digital; ESP32 streams over Wi-Fi |
| Reversibility | Total — phone circuitry untouched |

### 3.2 Alternatives considered

| Option | Verdict | Reason |
|---|---|---|
| ESP32 takes over phone internals directly (handover's original direction) | Rejected for now | Needs mic preamp, speaker amp, bell driver, dial decoding; handset/speaker/bell wires appear soldered to main PCB (H-05), so not solder-free or reversible |
| Off-the-shelf analog telephone adapter (ATA) + SIP voice service | Fallback only | Zero electronics, but needs Ethernet and an external box |

### 3.3 Software shape (D-02)

ESP32 is a **thin client**: phone control + audio streaming. A separate **AI relay** handles API keys, speech, LLM, and smart-home logic, so AI providers can change without reflashing the phone.

---

## 4. Hardware inventory

### 4.1 The telephone
- Manufacturer TelPal, model 301-Ivory, internal label MS-301H.
- ASIN B0CCQRJ7ZF · UPC 699838493506.

### 4.2 Equipment owned
| Item | Qty | Notes | Role in current plan |
|---|---|---|---|
| ESP32-S3 DevKitC-1-style, module S3-N16R8 (16 MB flash, 8 MB octal PSRAM) | 2 (2-pack) | USB + COM USB-C ports; headers pre-soldered; external antenna included, not needed (D-06) | Main controller (one spare) |
| 830-point breadboard | 1 | Prototyping only | Prototyping |
| USB breadboard power supply (3.3 V / 5 V) | 1 | | Likely unneeded |
| 320+ component starter kit | 1 | Contents to confirm when needed | Misc. resistors/LEDs/etc. |
| Dupont jumper wires (M-F, M-M) | assorted | | Prototyping |
| Digital multimeter | 1 | AstroAI AM33D, manual-ranging, 1999 max display | Testing |
| RJ11 adapters / connectors | assorted | Exact types to confirm | Connecting line module to phone |

### 4.3 Not owned — anticipated, NOT yet to be purchased
Purchase decision happens at the Phase 3 gate (D-03).

| Item | Why | Approx. cost |
|### 4.4 Smart-home inventory and control routes (Martin, 2026-11-07; routes are research findings, unverified on his devices)

| Devices | Count / names (as in Google Home) | Best route from the relay | Confidence |
|### 4.5 Purchases and costs

| Date | Supplier | Order | Items | Total (USD) |
|---|---|---|---|---|
| Before 2026-10-30 | Various | — | ESP32-S3 boards (2), breadboard, power module, starter kit, jumpers, multimeter, RJ11 adapters | Not recorded |
| 2026-11-07 | DigiKey | — | 2 × 470 µF, 5 × 0.1 µF, 5 × 0.01 µF, 4 × 1N4004, 2 × 1N4148, 2 × P6KE82A (subtotal $12.79; shipping $8.49; tariff $1.06 est.; tax $1.68) | **$24.02** (estimate) |
| 2026-11-07 | Symmetry Electronics (via americas.braemac.com) | #299683 | 2 × Silvertel AG1171S @ $8.50 (items $17.00; shipping $11.71; tax $2.16; tariff to be added before shipping) | **$30.87** + tariff |
| | | | **Phase 3 total so far** | **≈ $54.89** |

---|---|---|---|
| GE/Savant **Cync** Full Color bulbs (Matter-enabled; HW 1.0, SW 1.03.190) | 15: Dining Table Light 1–5 (BR30), Living Room (Left-side TV Lamp, Right-side TV Lamp, Pendant Lamp), Reading Room (Standing Lamp, Table Lamp), Office (Main Lamp), Master Bedroom (Bedside Lamp 1–2), Guest Bedroom (Lamp 1–2) | **No official public Cync API.** Options: (a) share the bulbs via Matter into **SmartThings** (Samsung TVs from 2022 onward, incl. The Frame, can act as a SmartThings/Matter hub) and control through the SmartThings cloud API, no purchase; (b) **Home Assistant** at home as a Matter controller or via its Cync cloud integration, reached securely from Railway, needs a small device; (c) Cync's private cloud API directly, fragile | Open (key Phase 7 question) |
| **SwitchBot** Blind Tilt | 4: Blind Tilt 1–3 (living room), 4 (dining room) | SwitchBot official cloud API from Railway (requires a SwitchBot Hub, likely present since they appear in Google Home) | High |
| **SwitchBot** Curtain | 1: "Curtain 47" (dining room) | Same as above | High |
| Samsung TVs | The Frame 65" **QN65LS03DAFXZA (2024)** (living room): listed by Samsung as having a built-in SmartThings hub (Thread border router, Matter controller), so a candidate for Cync route (a); Samsung 75" **U7900 (2025)** (master bedroom): not on the hub list | SmartThings cloud API | High (low priority to Martin) |
| Google Nest Doorbell (wired, 3rd gen) | 1 | Google Device Access (one-time $5 fee): doorbell-press events could **ring the phone**. Some 3rd-gen units have had missing chime events; reported workaround | Medium (stretch goal) |
| WiiM streamer → Herdio HWA16BT amp → built-in speakers; turntable into WiiM | 1 | WiiM has a local-network-only API, so it needs a hub at home | Low priority |
| Kitchen island lights (SmartRent, landlord-owned) | — | No public API; out of scope | — |

**Non-device capabilities wanted:** reminders with ring-back, weather, online lookups. All handled by the relay and AI tools; no home hardware needed.

---|---|---|
| SLIC line module (Silvertel AG1171) ×2 + support parts | Line voltage, ringing, hook detection; see `docs/phase3-shopping-list.md` | ~$25 + shipping (DigiKey) |
| I2S audio codec board | Deferred (D-14): try ESP32-S3 built-in ADC + PDM output first | Only if needed |
| Possibly a 5 V / 2 A USB power adapter | Telephony can draw ~450–500 mA off-hook/ringing plus ESP32 Wi-Fi peaks | TBD |

---

## 5. Confirmed observations

| ID | Observation | Source | Date |
|---|---|---|---|
| C-01 | Phone is TelPal 301-Ivory, internal label MS-301H | Base label photo | 2026-10-30 |
| C-02 | Dial face has 12 positions: 1–9, 0, *, # | Front photo | 2026-10-30 |
| C-03 | Main PCB has a 9-pin plug-in connector labeled (in order) GND, HF, L1, KG, L4, L3, L2, LED+, LED− | PCB photos | 2026-10-30 |
| C-04 | The blue component directly under the cradle is the hook switch, on its own small board; a separate 4-pin plug-in cable connects it to the main PCB | Martin, visual inspection | 2026-10-30 |
| C-05 | Main PCB is silkscreened "2018.8.24 MB"; a quartz crystal sits near the 9-pin connector; transformer footprint "T1" is unpopulated | PCB photos | 2026-10-30 |
| C-06 | A brass gong-type bell assembly is present; it rattles metallically when the phone is shaken | Photos, Martin | 2026-10-30 |
| C-07 | Base underside has: RJ11 line jack, handset jack, VOLUME LO/HI slide switch, wall-mount keyhole, and a rectangular covered panel ("QC PASS" sticker) | Base photo | 2026-10-30 |
| C-08 | Handset connects via a coiled cord to a jack in the base | Photos | 2026-10-30 |
| C-09 | Main PCB top side shows only through-hole parts (capacitors, crystal, transistor); integrated circuits not yet seen | PCB photos | 2026-10-30 |
| C-10 | ESP32-S3 board has two USB-C ports | Martin | 2026-10-30 |
| C-11 | Main PCB underside is surface-mount. Three ICs: U2 (~18–20-pin SOP; partial marking appears to read "UTC…" / "M5F2…", unconfirmed), U3 (~14–16-pin SOP, marking hidden by wires), U4 (small 6–8-pin, marking unreadable). Also U6, a 4-pin package next to the green/red wire pair at top-left. Many zener diodes (ZD1–ZD7) and transistors (Q1, Q2, Q5, Q9, Q10) | P-07 | 2026-10-30 |
| C-13 | U4 (8-pin SOP) is marked **HT9200A** (text reads upside down in the photo): a Holtek DTMF touch-tone generator that takes digits over a serial link and runs from a 3.58 MHz crystal | P-08a | 2026-10-30 |
| C-14 | U2 (16-pin SOP) is marked "UTC106? / M5F2LD" (third digit partly unclear) — Unisonic (UTC) part, consistent with UTC's TEA1062 telephone speech-transmission IC sold as "1062" in SOP-16 | P-08c | 2026-10-30 |
| C-15 | U3 (14-pin SOP) has no legible marking | P-08b | 2026-10-30 |
| C-16 | U6 is marked **MB6F**: a 600 V / 0.5 A bridge rectifier, next to the line-input wire pair | P-08d (Martin read marking) | 2026-10-30 |
| C-17 | Crystal X1 is marked "3.579…" — the standard 3.579545 MHz color-burst crystal used for DTMF | P-09a, P-09b | 2026-10-30 |
| C-18 | The board behind the dial is labeled **PCB02**. It carries the HANDS FREE push-button, four black-domed optical components labeled LED1–LED4, the 9-way ribbon to the main PCB, and a separate 4-way gray ribbon labeled LD+, LD−, KG, GND running into the dial mechanism. The dial's rear plate has a row of 4 holes in line with LED1–LED4 | P-10 | 2026-10-30 |
| C-19 | The bell is an enclosed brass gong with a center screw; it has two wires of its own (red and black) running to the main PCB, not directly to the line jack | P-12 | 2026-10-30 |
| C-20 | The line jack connects to the main PCB with a 2-wire pair (green/red); the handset jack with a 4-wire harness (red, green, yellow, black) | P-12, P-13 | 2026-10-30 |
| C-21 | Hook-switch board: blue switch in a white housing on a separate small board (silkscreen "HOOK"); 4-wire ribbon to the main PCB; underside shows 5 soldered switch pins | P-11a, P-11b | 2026-10-30 |
| C-22 | The covered panel on the base opens into an empty compartment — no battery contacts or electronics. The base also contains a steel ballast plate | P-13 | 2026-10-30 |
| C-23 | ESP32 module is marked "S3-N16R8". It has **both** a PCB trace antenna (zig-zag on the module tab) and a tiny U.FL external-antenna connector | P-14a | 2026-10-30 |
| C-24 | ESP32 dev board: USB-C ports labeled **USB** (left, native USB-OTG) and **COM** (right, via CH343P USB-serial chip); AMS1117 3.3 V regulator; onboard RGB LED; RST and BOOT buttons. **Pin headers are already soldered** — the board plugs straight into a breadboard | P-14a–c | 2026-10-30 |
| C-25 | esptool report: ESP32-S3 (QFN56) rev v0.2, Wi-Fi + BT 5 (LE), dual core 240 MHz, embedded 8 MB PSRAM, 40 MHz crystal, USB mode USB-Serial/JTAG | T-002 upload log | 2026-11-07 |
| C-26 | Onboard RGB LED is on **GPIO 48** | T-002 | 2026-11-07 |
| T-003 | 2026-11-07 | Wi-Fi join: `01-wifi` connects to home network, prints IP, MAC, channel and signal strength every 5 s; LED blue = connecting, green = connected, red = failed | Board on bench next to Mac; USB CDC On Boot: Enabled; Serial Monitor 115200 baud | Connects within 20 s; signal "good" or better on the bench | LED green; CONNECTED; signal steady at −35 to −36 dBm (excellent). Port shown as `/dev/cu.usbmodem101` with USB CDC On Boot enabled | **Pass.** Wi-Fi works with the built-in PCB antenna (supports D-06). Signal inside the closed phone at its final location still to be checked later |
| T-004 | 2026-11-07 | Relay hello: `relay/server.mjs` running on the Mac (Node v24.16.0) | `npm install ws`, `node server.mjs` in `~/switchboard-relay` | Prints "listening on port 8080" and the Mac's local IP address | "Switchboard relay listening on port 8080"; "Board should connect to: 192.168.1.87 (port 8080)" | **Pass.** Note: the Mac's local address can change (assigned by the router); if the board can't find the relay later, re-check it |
| T-005 | 2026-11-07 | Board ↔ relay round trip: `02-relay-hello` joins Wi-Fi, opens a WebSocket to the relay on the Mac, sends a greeting and a message every 10 s; relay replies | Library "WebSockets" by Markus Sattler; secrets.h with RELAY_HOST 192.168.1.87, port 8080 | LED green; relay logs the connection and messages | Relay log: "Phone connected from 192.168.1.56", "Hello from the phone!", "Still here #1", "#2" at ~10 s intervals | **Pass.** Persistent two-way connection between board and relay works on the home network. Board's address: 192.168.1.56 |
| T-006 | 2026-11-07 | Test B, audio throughput: `03-audio-stream` sends a 440 Hz tone as 16 kHz 16-bit mono (256 kbit/s) in 20 ms frames for 60 s; relay echoes each frame, reports rate and frame spacing, saves `test-tone.wav` | Board on bench (−42 dBm), Wi-Fi power-save off; relay on Mac | ~3,000 frames received; ~256 kbit/s; average spacing ~20 ms; under 1% of gaps over 60 ms; echo ~100%; WAV plays a clean steady tone | Relay: **3000/3000 frames, 1875.0 KB in 60.0 s, 256 kbit/s, average spacing 20.0 ms, worst gap 132 ms, 130 gaps over 60 ms (4.3%)**. Board: **3000 frames / 1,920,000 bytes sent, 1,920,000 bytes echoed back (100.0%)**; progress lines every ~5 s. WAV: **clean, steady beep** (Martin) | **Pass on throughput (no loss, exact rate); jitter higher than hoped.** Frames arrive in small bursts (typical of Wi-Fi + TCP batching), so the audio path needs a ~150–200 ms playout buffer (D-16). Possible later improvements: disable TCP delayed sending (Nagle), larger frames |
| C-27 | Uploading over the native USB port needs **manual upload mode** (hold BOOT, tap RST, release BOOT), re-selecting the port afterward because its name changes (seen: `usbmodem1234561` in normal running, `usbmodem101` in upload mode). Press RST after upload to start the new program | T-002 | 2026-11-07 |
| C-28 | Home Wi-Fi is a single network name broadcasting both 2.4 GHz and 5 GHz; existing smart bulbs etc. connect on 2.4 GHz (seen in the Spectrum app) | Martin | 2026-11-07 |
| C-12 | Handset, speaker, microphone and other harness wires (red, black, green, yellow) are soldered directly to the main PCB; only the 9-pin and 4-pin harnesses are plug-in | P-07 | 2026-10-30 |

---

## 6. Working hypotheses

| ID | Hypothesis | Basis | How we will test | Status |
|---|---|---|---|---|
| H-01 | The "rotary" dial is an electronic keypad emulation; the phone dials with DTMF touch tones, not pulses | * and # positions (C-02) are impossible on a pulse dial; crystal (C-05) typical of DTMF generators | IC part numbers (Phase 0); later, decode tones (Phase 4) | **Strongly supported** by C-13 (HT9200A DTMF generator on board); final confirmation by decoding tones in Phase 4 |
| H-02 | The crystal is a ~3.58 MHz DTMF-type crystal | Typical for tone-dialer chips | Close-up photo of its marking | **Confirmed by C-17** |
| H-03 | The dial is an **optical encoder**: an emitter inside the dial (LD+/LD−) shines through holes in the rotating disc onto four sensors (LED1–LED4 on PCB02), giving a 4-bit position code on L1–L4; KG is a dial switch (likely "dial pulled/released"); HF is the HANDS FREE button; LED+/LED− power the emitter | C-18: four sensors aligned with 4 holes, matching L1–L4 and LD± labels | Only needed if architecture changes (D-04) | Strongly supported; parked |
| H-04 | The bell is driven by the main PCB (which detects the line's ringing signal and powers the bell's coil), so a standard ringing signal from a 1-REN SLIC will ring it | C-19: bell wired to PCB, not directly to the line | Phase 4 ring test | Open (refined) |
| H-05 | Handset, speaker, and bell wires are soldered directly to the main PCB (only the 9-pin and 4-pin harnesses are plug-in) | Top-side photos show wires entering board | Underside photo | **Confirmed by C-12** — reinforces D-01 |
| H-06 | The phone behaves as a standard US loop-powered analog telephone | Designed for analog lines | Chip IDs; Phase 4 | Open |
| H-07 | Hook switch and hands-free button both simply take the phone "off-hook" from the line's point of view | Normal phone design | Phase 4 | Open |
| H-08 | U6 is a bridge rectifier at the line input, making the phone insensitive to line polarity | MB6F marking | — | **Confirmed by C-16** |
| H-09 | U3 is an unmarked microcontroller that scans the dial (L1–L4/KG) and hands-free button, and sends digits serially to the HT9200A (U4) | Traces from the 9-pin connector run toward U3; HT9200A needs a controller to feed it; unmarked MCUs are common in budget phones | Phase 4 (indirect); not needed under D-01 | Revised (was: U3 = dialer) |
| H-10 | U2 is a UTC1062 (TEA1062-type) speech network: handset mic/earpiece interface and line-powered audio | C-14 marking; 16-pin SOP matches | Datasheet comparison of pin connections if ever needed | Open |

---

## 7. Decisions

| ID | Decision | Rationale | Date | Status |
|---|---|---|---|---|
| D-01 | Architecture: treat the phone as a stock black box; ESP32-S3 + SLIC (+ audio conversion, see D-14) emulate a phone line | Solves power, bell, dial, hands-free and reversibility at once; proven by open-source projects (weeBell, RotaryCell). Phase 0–2 found nothing against it | 2026-10-30 | **Committed** at Phase 3 gate (2026-11-07) |
| D-02 | ESP32 is a thin client; AI and smart-home logic live in a separate relay service | Keeps keys off device; provider changes need no reflash | 2026-10-30 | Accepted in principle |
| D-03 | No purchases until the Phase 3 decision gate | Cost control; validate first | 2026-10-30 | Active |
| D-04 | Electrical investigation of the 9-pin ribbon is deprioritized | Not needed under D-01 | 2026-10-30 | Active |
| D-05 | This log is the living record, kept both as a claude.ai Project doc and in the git repo | Continuity across conversations plus version history | 2026-10-30 | Active |
| D-06 | Use the module's built-in PCB antenna; do not fit the external antenna | C-23: module has PCB antenna (external connector is optional); revisit only if Wi-Fi is weak inside the phone | 2026-10-30 | Active (updated) |
| D-07 | Code and docs live in private GitHub repo `martinmccafferty/project-switchboard`; secrets (Wi-Fi passwords, API keys) are never committed | Created early so history starts at Phase 0 | 2026-10-30 | Active |
| D-08 | Close Phase 1 without further unpowered line tests; move to Phase 2 (ESP32 bring-up) | Phase 1's goal (confirm a standard tone-dialing analog phone) is met by Phase 0 evidence (C-13, C-16, C-17); unpowered hook testing cannot show off-hook on this electronic phone (T-001) | 2026-10-30 | Active |
| D-09 | Firmware toolchain for Phase 2 bring-up: Arduino IDE 2 on Martin's Mac with the "esp32 by Espressif Systems" core (Arduino-ESP32). Prefer the board's native **USB** port (driverless on macOS); fall back to **COM** if needed | Simplest graphical setup for a first-time user; Arduino-ESP32 supports I2S audio, Wi-Fi and Matter, so it can carry the project. Revisit (PlatformIO/ESP-IDF via Claude Code) if the codebase outgrows it | 2026-11-07 | Active |
| D-10 | Secrets (Wi-Fi credentials, later API keys) go in a per-sketch `secrets.h`, ignored by git; a `secrets.h.example` template is committed instead | Keeps credentials off GitHub (D-07) | 2026-11-07 | Active |
| D-11 | AI relay hosting: develop and test on Martin's Mac now; production on **Railway** | Martin wants the phone to be **portable** (take it elsewhere, join that Wi-Fi, still work). A cloud relay is reachable from any internet connection; a home server would need remote-access setup (port forwarding or a VPN like Tailscale) to work away from home. Also: Railway needs no purchase, ~$5/month plan, already proven in Martin's stack (Continuum engine). Home server remains an *optional* later add-on only if Phase 7 needs local smart-home control. Google Nest Mini, SwitchBot, WiiM ruled out as hosts (closed firmware). Vercel ruled out (WebSockets end at function max duration, billed while open) | 2026-11-07 | Active (revised twice same day) |
| D-12 | Wi-Fi set-up without reprogramming: when the phone can't join a saved network, it starts its own temporary Wi-Fi hotspot (e.g. "Switchboard-Setup"); Martin joins it from his mobile, a set-up page opens, he picks the network and enters the password; the phone saves it (remembering several networks, e.g. home plus others). Likely via the WiFiManager library. `secrets.h` stays only for bench development until this is built | Portability goal. Known limits: Wi-Fi with a browser sign-in page (hotels, cafés) and corporate (WPA2-Enterprise) networks won't work; a mobile hotspot is the fallback | 2026-11-07 | Active — build after core phone functions work |
| D-13 | Smart-home principle: the relay talks to each device maker's own service directly (SwitchBot, SmartThings, Cync, etc.), **bypassing Google Home** as the control path. Google Home and its voice control keep working in parallel, untouched | Martin's stated preference; also Google Home has no general server-side control API | 2026-11-07 | Active |
| D-14 | **Defer the audio codec board.** First try the ESP32-S3's built-in converters: ADC1 samples the AG1171's VOUT (biased to mid-supply), and PDM or sigma-delta output through an RC filter drives VIN, at telephone bandwidth (300–3400 Hz, 8–16 kHz sampling). Buy a codec only if quality proves inadequate | Minimize purchases. Telephone audio is narrowband, so built-in converters may suffice. Solder-free codec boards with line-level I/O proved scarce: SparkFun WM8960 with headers is retired, the weeBell POTS shield is sold out, and most modules ship with loose headers | 2026-11-07 | Active (revisit after first audio tests) |
| D-15 | Produce a public **build guide** at the end of the project so others can build the same phone. Gotchas and practical lessons are collected as we go in `docs/build-guide-notes.md` | Martin's stated intention | 2026-11-07 | Active |
| D-16 | Both ends of the audio path use a playout (jitter) buffer of ~150–200 ms, so bursty Wi-Fi delivery doesn't cause stutters | T-006: worst gap 132 ms, 4.3% of gaps over 60 ms, zero loss | 2026-11-07 | Active |
| D-17 | Operator "brain" = **pipeline**: speech-to-text → **Claude** (with tools) → text-to-speech, orchestrated by the relay (option A). **Call opening (corrected by Martin):** dialing 0 instantly plays a stored switchboard click + "Operator. How may I help you?" (zero latency, covers connection setup); after the caller's **first** request the operator says "One moment, connecting you…" (stored clip) while the first reply is prepared. Later turns get no scripted filler, only a very short cue (click or "Mm-hm") if a reply takes over ~1.5 s, cut off as soon as speech is ready | Martin is a keen Anthropic user; Claude is strong at tool use; each piece stays swappable. Anthropic's API (as far as found, Nov 2026) has no speech-to-text, text-to-speech or realtime voice endpoint. Martin: a long scripted line on every turn would outlast the real wait | 2026-11-08 | Active (call-opening order corrected same day) |
| D-18 | Speech provider: **OpenAI** for both transcription and voice (TTS instructed to sound like a 1950s switchboard operator) | One API key and account covers both directions (simplest). Google's Gemini TTS can also be steered by style prompts, so the voice can be auditioned against it later if wanted | 2026-11-08 | Active |

---

## 8. Open questions

| ID | Question | Needed by |
|---|---|---|
| ~~Q-01~~ | ~~What is behind the covered panel?~~ Answered: empty compartment (C-22) | — |
| ~~Q-02~~ | ~~IC part numbers~~ Answered: U2 ≈ UTC1062, U3 unmarked, U4 = HT9200A, U6 = MB6F | — |
| Q-03 | Does the phone have a tone/pulse setting anywhere? (Only VOLUME switch seen so far) | Phase 0–1 |
| ~~Q-04~~ | ~~Where will the AI relay run?~~ Answered: Mac for development, Railway for production (D-11) | — |
| ~~Q-05~~ | Answered by D-18 (OpenAI). Was: Speech provider for the pipeline (D-17): prefer one Martin already has an account with (OpenAI, Google Cloud or IBM watsonx, all used by Continuum) to avoid new subscriptions; pay-per-use. Candidate: OpenAI (transcription plus a TTS voice that can be instructed to sound like a vintage operator) or Google Cloud Speech | Phase 5 |
| Q-06 | Google Home integration: ESP32 as a Matter device (good for "ring the phone" notifications); control in the other direction still unresolved | Phase 7 |
| Q-07 | Solder-free permanent assembly method (pre-made carrier board, screw terminals, etc.) | Phase 8 |
| ~~Q-08~~ | ~~ESP32 antenna variant~~ Answered: PCB antenna + optional U.FL (C-23) | — |
| Q-09 | Which audio codec board, and is the existing USB power adequate? | Phase 3 |
| ~~Q-10~~ | ~~Does Martin have a GitHub account?~~ Answered: yes — repo created (D-07) | — |
| Q-11 | Smart-home control path for the **Cync lights**: first try SmartThings via The Frame's built-in hub (qualifies); fall back to Home Assistant at home or Cync's private API. To test in Phase 7: whether the TV hub keeps working in standby. Still to confirm: whether a SwitchBot Hub exists | Phase 7 |
| Q-12 | AG1171 logic levels: with the module on 5 V, is its SHK output 5 V (would need a resistor divider before the 3.3 V ESP32 input), and do its RM and F/R inputs accept 3.3 V as logic high? Check datasheet DC characteristics before wiring | Phase 4 wiring |

---

## 9. Roadmap

| Phase | Scope | Purchases | Status |
|---|---|---|---|
| 0 | Photo survey & part identification; set up this log and repo | None | **Complete** |
| 1 | Simple unpowered checks to confirm the phone is a standard tone-dialing analog phone | None | Closed (D-08): goal met by Phase 0 evidence; T-001 showed open circuit at meter voltage |
| 2 | ESP32 bring-up: flash, Wi-Fi, test audio streaming to a relay; choose toolchain | None | **Complete** (T-002–T-006) |
| 3 | **Decision gate**: commit architecture; order line module (codec deferred, D-14) | Yes | **Ordered** 2026-11-07; awaiting delivery |
| 4 | Line emulation: off-hook detection, dial tone, DTMF decoding, ringing the bell | — | Not started |
| 5 | AI conversation through the handset | — | Not started |
| 6 | Hands-free with echo cancellation | — | Not started |
| 7 | Smart-home integration | — | Not started |
| 8 | Permanent compact install inside the phone + reliability soak test | TBD | Not started |
| 9 | Public build guide (D-15), from this log and `docs/build-guide-notes.md` | None | Not started |

### Phase 0 checklist (phone unplugged from any wall jack, no power)
- [x] Engineering log created
- [x] GitHub repo created and seeded
- [x] Hook switch identified (C-04, C-21)
- [x] Main PCB underside (P-07)
- [x] Chip close-ups U2, U3, U4, U6 (P-08a–d)
- [x] Crystal (P-09a–b)
- [x] Dial board (P-10)
- [x] Hook-switch board (P-11a–b)
- [x] Bell (P-12)
- [x] Base panel (P-13)
- [x] ESP32 board (P-14a–c)

---

## 10. Test log

| ID | Date | Test | Setup | Expected | Observed | Conclusion |
|---|---|---|---|---|---|---|
| T-001 | 2026-10-30 | Line-jack hook test (unpowered): AstroAI AM33D on diode-test setting, probes via male-male Dupont pins pushed into the phone line cord's plug | Phone unplugged from wall; contact technique verified by a beep end-to-end through the line cord's middle contacts | On-hook "1"; handset lifted: a number | A (on-hook) "1"; B (handset lifted) "1", with contact confirmed | **Valid result, not a fault:** at the meter's diode-test voltage the phone shows an open circuit both on- and off-hook. Consistent with an electronic hook circuit (transistors + speech chip) that only conducts under real line voltage. Off-hook detection to be verified in Phase 4 |
| T-002 | 2026-11-07 | First upload: `00-blink` cycles onboard RGB LED red/green/blue/off | Board on Mac via native **USB** port; Tools → Board: ESP32S3 Dev Module; IDE 2.3.10, core 3.3.12 | LED cycles colors every 0.5 s | Auto-upload failed ("No serial data received") on `/dev/cu.usbmodem1234561`. After manual upload mode (hold BOOT, tap RST, release BOOT) the port re-appeared as `/dev/cu.usbmodem101`; upload completed and verified. After pressing RST, LED cycled red → green → blue → off | **Pass.** Board, cable, toolchain and upload path all work. Onboard RGB LED is on GPIO 48 |

---

## 11. Wiring and pinouts

### 11.1 Telephone main PCB — 9-pin connector (labels only, functions unverified)
| Pos | Label | Hypothesized function (H-03) |
|---|---|---|
| 1 | GND | Circuit ground |
| 2 | HF | Hands-free button |
| 3 | L1 | Dial encoding |
| 4 | KG | Dial common / key ground |
| 5 | L4 | Dial encoding |
| 6 | L3 | Dial encoding |
| 7 | L2 | Dial encoding |
| 8 | LED+ | Indicator LED anode |
| 9 | LED− | Indicator LED cathode |

### 11.2 Telephone main PCB — 4-pin connector
Connects hook-switch board to main PCB (C-04). Pin functions not investigated (not needed under D-01).

### 11.3 ESP32-S3 dev board (S3-N16R8) — as observed (P-14a–c)
- Module: S3-N16R8 (16 MB flash, 8 MB octal PSRAM), PCB antenna + optional U.FL connector (D-06: use PCB antenna).
- USB-C ports: **USB** (left) = chip's native USB-OTG; **COM** (right) = CH343P USB-to-serial. Either powers and programs the board.
- Pin headers pre-soldered; breadboard-ready.
- Left header (top→bottom): 3V3, 3V3, RST, 4, 5, 6, 7, 15, 16, 17, 18, 8, 3, 46, 9, 10, 11, 12, 13, 14, 5Vin, GND.
- Right header (top→bottom): GND, TX, RX, 1, 2, 42, 41, 40, 39, 38, 37, 36, 35, 0, 45, 48, 47, 21, 20, 19, GND, GND.
- Avoid: GPIO 35, 36, 37 (used by octal PSRAM); GPIO 0, 3, 45, 46 (boot-strapping pins); GPIO 19/20 (native USB).
- Onboard RGB LED on GPIO 48 (confirmed, C-26).
- **Upload procedure:** with USB CDC On Boot enabled, normal **Upload** works without buttons (T-003). Fallback if it fails (C-27): hold BOOT, tap RST, release BOOT → Tools → Port → pick the `usbmodem…` entry → Upload → press RST.
- No wiring done yet.

---

## 12. Firmware and software
- None yet.
- Repo layout: `firmware/` (ESP32-S3), `relay/` (AI relay service), `docs/` (this log, photos, pinouts).
- Toolchain: Arduino IDE 2 + Arduino-ESP32 core (D-09). Board-support URL: https://espressif.github.io/arduino-esp32/package_esp32_index.json
- Development machine: Martin's Mac (Node.js v24.16.0 installed). Installed 2026-11-07: Arduino IDE 2.3.10; "esp32 by Espressif Systems" core 3.3.12.
- Sketches live in `firmware/<nn-name>/<nn-name>.ino` (Arduino requires the folder and file names to match). First sketch: `firmware/00-blink`.

---

## 13. Reference projects and documents
- **weeBell** (Dan Julio) — ESP32 + Silvertel AG1171 SLIC + ES8388 codec providing a single 600-ohm phone line: ringing, audio, hook and rotary/DTMF decoding, line echo cancellation. https://hackaday.io/project/191002 · https://github.com/danjulio/weeBell_hardware
- **RotaryCell** — ESP32-S3 + AG1171 + cellular modem driving an unmodified rotary phone (dial, hook switch, mechanical bell). https://www.electronicsforu.com/news/esp32-s3-and-a7670-modem-bring-rotary-phones-to-lte
- **Holtek HT9200A datasheet** (U4) — https://html.alldatasheet.com/html-pdf/206143/HOLTEK/HT9200A/216/1/HT9200A.html
- **UTC TEA1062 datasheet** (likely U2) — https://html.alldatasheet.jp/html-pdf/424974/UTC/TEA1062N-D16-T/597/9/TEA1062N-D16-T.html
- **Silvertel AG1171 datasheet** — https://static.chipdip.ru/lib/300/DOC029300244.pdf
- Original ChatGPT handover: "Project Switchboard v1-0.docx" (superseded where this log differs).
- **Photos:** `docs/photos/` — P-01 to P-14c committed (Phase 0 survey complete). Index and shot list in `docs/photos/README.md`.

---

## 14. Change history
| Date | Version | Change |
|---|---|---|
| 2026-10-30 | v1 | Log created from handover review, photo analysis, architecture proposal; added C-04 (hook switch) and ESP32 board details from Martin |
| 2026-10-30 | v1.1 | GitHub repo created and seeded (D-07); Q-10 answered; log now mirrored in repo |
| 2026-10-30 | v1.2 | Original six photos committed as P-01–P-06; Phase 0 shot list defined as P-07–P-14 |
| 2026-10-30 | v1.3 | P-07 (PCB underside) added: C-11, C-12; H-05 confirmed; H-08, H-09 added |
| 2026-10-30 | v1.4 | Chip close-ups P-08a–c: U4 = HT9200A DTMF generator (C-13), U2 ≈ UTC1062 speech network (C-14), U3 unmarked (C-15); H-01 strongly supported; H-09 revised; H-10 added |
| 2026-10-30 | v1.5 | Phase 0 complete. Added C-16–C-24 (MB6F bridge, 3.579 MHz crystal, optical dial board PCB02, bell wiring, hook switch, empty panel, ESP32 board details). H-02, H-08 confirmed; H-03 revised to optical encoder; H-04 refined; Q-01, Q-02, Q-08 answered; D-06 updated |
| 2026-10-30 | v1.6 | Phase 1 started: T-001 planned; multimeter model recorded |
| 2026-10-30 | v1.7 | T-001 recorded as inconclusive; D-08 proposed (close Phase 1, move to Phase 2) |
| 2026-10-30 | v1.8 | T-001 updated: contact confirmed, phone open-circuit both on- and off-hook at meter voltage; D-08 accepted, Phase 1 closed |
| 2026-11-07 | v1.9 | Phase 2 started; D-09 toolchain decision (Arduino IDE 2 on Mac) |
| 2026-11-07 | v1.10 | Toolchain installed (IDE 2.3.10, core 3.3.12); first sketch `00-blink` added; T-002 planned |
| 2026-11-07 | v1.11 | T-002 passed: first successful upload, LED blinking; C-25–C-27 added (chip details, LED on GPIO 48, manual upload procedure) |
| 2026-11-07 | v1.12 | Sketch `01-wifi` added; T-003 planned; C-28 (home Wi-Fi is dual-band single name); D-10 (secrets handling) |
| 2026-11-07 | v1.13 | T-003 passed: board on home Wi-Fi, −35 dBm |
| 2026-11-07 | v1.14 | D-11 relay hosting (Mac now, Railway later); Q-04 answered; upload now works without BOOT/RST buttons |
| 2026-11-07 | v1.15 | D-11 revised: production host deferred (Railway vs home server); Q-04 reopened for Phase 7 |
| 2026-11-07 | v1.16 | Portability requirement: D-11 settled on Railway for production; D-12 Wi-Fi set-up hotspot planned |
| 2026-11-07 | v1.17 | Target experience recorded (dial 0, lights, blinds, reminders with ring-back); Q-11 smart-home control path; relay hello-world added; T-004 planned |
| 2026-11-07 | v1.18 | Smart-home inventory and control-route research added (section 4.4); Q-11 narrowed to the Cync lights |
| 2026-11-07 | v1.19 | D-13: control devices directly, bypassing Google Home |
| 2026-11-07 | v1.20 | TV models recorded; The Frame (2024) qualifies as a SmartThings hub; Q-11 updated |
| 2026-11-07 | v1.21 | T-004 passed (relay running on Mac at 192.168.1.87:8080); sketch `02-relay-hello` added; T-005 planned |
| 2026-11-07 | v1.22 | T-005 passed: board ↔ relay round trip working; Phase 2 core complete |
| 2026-11-07 | v1.23 | Phase 3: architecture committed; shopping list created; D-14 defer codec; Q-12 logic levels |
| 2026-11-07 | v1.24 | AG1171 sourcing: DigiKey/Newark backordered; Symmetry Electronics in stock |
| 2026-11-07 | v1.25 | Parts ordered (section 4.5 costs); D-15 public build guide; `docs/build-guide-notes.md` started; Phase 9 added |
| 2026-11-07 | v1.26 | Test B prepared: sketch `03-audio-stream`, relay audio-test support; T-006 planned |
| 2026-11-07 | v1.27 | T-006 result (incl. 100% echo): zero loss, 256 kbit/s, bursty arrival (worst gap 132 ms); D-16 jitter buffer; Phase 2 complete |
| 2026-11-07 | v1.28 | T-006 WAV check: clean, steady tone |
| 2026-11-08 | v1.29 | D-17 operator pipeline with Claude and instant operator phrases; Q-05 narrowed to speech provider |
| 2026-11-08 | v1.30 | D-17 filler policy refined; D-18 OpenAI for speech; Phase 5 brief written |
| 2026-11-08 | v1.31 | D-17 call-opening order corrected: greeting first, "connecting you" after the first request; handed relay build to Claude Code on Martin's Mac |
