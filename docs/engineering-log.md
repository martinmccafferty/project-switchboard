# Project Switchboard — Engineering Log

**Owner:** Martin McCafferty · **Engineering partner:** Claude
**Last updated:** 2026-10-30 (Log v1.6)
**Current phase:** Phase 0 — Identification & documentation

> How to use this log: it is the single source of truth between conversations. Claude updates it after every session that produces a discovery, decision, or test result. Items are numbered (C = confirmed, H = hypothesis, D = decision, Q = open question, T = test) so they can be referenced in conversation ("H-01 is now confirmed by T-003").
>
> Two copies are kept in sync: this file in the GitHub repo (`docs/engineering-log.md`, version history) and the Project Switchboard doc on claude.ai (`claude/switchboard-engineering-log.md`, read automatically by new chats).

---

## 1. Status summary

- Telephone opened, photographed, and reassembled. No electrical measurements yet.
- Architecture direction "Build the phone line, not a new phone" accepted in principle (D-01). Final commitment happens at the Phase 3 decision gate.
- GitHub repository `martinmccafferty/project-switchboard` created (private) and seeded (D-07).
- **Phase 0 complete** (photo survey done; nothing found that challenges D-01). Next action: Phase 1 — unpowered multimeter checks (not started; awaiting Martin's go-ahead).

---

## 2. Goal and constraints

**Goal:** Turn a TelPal 301-Ivory retro telephone into a Wi-Fi AI telephone and smart-home interface that still feels like a genuine old-fashioned phone.

**Constraints (from Martin):**
- Solder-free if at all possible; reversible modifications.
- Externally unchanged apart from a discreet USB power cable.
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
|---|---|---|
| SLIC line module (Silvertel AG1171 or equivalent) | Line voltage, ringing, hook detection | ~$8.50 (DigiKey, Oct 2026) + shipping |
| I2S audio codec board (e.g. ES8388-based) | ESP32-S3 has no built-in analog audio output/input suitable for this | TBD |
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
| D-01 | Architecture: treat the phone as a stock black box; ESP32-S3 + SLIC + audio codec emulate a phone line | Solves power, bell, dial, hands-free and reversibility at once; proven by open-source projects (weeBell, RotaryCell) | 2026-10-30 | Accepted in principle; commit at Phase 3 gate |
| D-02 | ESP32 is a thin client; AI and smart-home logic live in a separate relay service | Keeps keys off device; provider changes need no reflash | 2026-10-30 | Accepted in principle |
| D-03 | No purchases until the Phase 3 decision gate | Cost control; validate first | 2026-10-30 | Active |
| D-04 | Electrical investigation of the 9-pin ribbon is deprioritized | Not needed under D-01 | 2026-10-30 | Active |
| D-05 | This log is the living record, kept both as a claude.ai Project doc and in the git repo | Continuity across conversations plus version history | 2026-10-30 | Active |
| D-06 | Use the module's built-in PCB antenna; do not fit the external antenna | C-23: module has PCB antenna (external connector is optional); revisit only if Wi-Fi is weak inside the phone | 2026-10-30 | Active (updated) |
| D-07 | Code and docs live in private GitHub repo `martinmccafferty/project-switchboard`; secrets (Wi-Fi passwords, API keys) are never committed | Created early so history starts at Phase 0 | 2026-10-30 | Active |

---

## 8. Open questions

| ID | Question | Needed by |
|---|---|---|
| ~~Q-01~~ | ~~What is behind the covered panel?~~ Answered: empty compartment (C-22) | — |
| ~~Q-02~~ | ~~IC part numbers~~ Answered: U2 ≈ UTC1062, U3 unmarked, U4 = HT9200A, U6 = MB6F | — |
| Q-03 | Does the phone have a tone/pulse setting anywhere? (Only VOLUME switch seen so far) | Phase 0–1 |
| Q-04 | Where will the AI relay run (home computer, Raspberry Pi, cloud service)? | Phase 2 |
| Q-05 | Which AI voice stack: realtime speech-to-speech API vs. speech-to-text → LLM (e.g. Claude) → text-to-speech? | Phase 2–5 |
| Q-06 | Google Home integration: ESP32 as a Matter device (good for "ring the phone" notifications); control in the other direction still unresolved | Phase 7 |
| Q-07 | Solder-free permanent assembly method (pre-made carrier board, screw terminals, etc.) | Phase 8 |
| ~~Q-08~~ | ~~ESP32 antenna variant~~ Answered: PCB antenna + optional U.FL (C-23) | — |
| Q-09 | Which audio codec board, and is the existing USB power adequate? | Phase 3 |
| ~~Q-10~~ | ~~Does Martin have a GitHub account?~~ Answered: yes — repo created (D-07) | — |

---

## 9. Roadmap

| Phase | Scope | Purchases | Status |
|---|---|---|---|
| 0 | Photo survey & part identification; set up this log and repo | None | **Complete** |
| 1 | Simple unpowered checks to confirm the phone is a standard tone-dialing analog phone | None | **Next** |
| 2 | ESP32 bring-up: flash, Wi-Fi, test audio streaming to a relay; choose toolchain | None | Not started |
| 3 | **Decision gate**: commit architecture; order line module + codec (+ PSU if needed) | Yes | Not started |
| 4 | Line emulation: off-hook detection, dial tone, DTMF decoding, ringing the bell | — | Not started |
| 5 | AI conversation through the handset | — | Not started |
| 6 | Hands-free with echo cancellation | — | Not started |
| 7 | Smart-home integration | — | Not started |
| 8 | Permanent compact install inside the phone + reliability soak test | TBD | Not started |

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
| T-001 | 2026-10-30 | Line-jack hook test (unpowered): AstroAI AM33D on diode-test setting, probes on the two center contacts of the phone's own line cord, plugged into LINE jack, wall end free | Phone unplugged from wall; readings on-hook, handset lifted, HANDS FREE pressed (handset down), handset lifted with probes swapped | On-hook: "1" (open). Handset lifted: a number (line path closed). HANDS FREE: may stay "1" because the phone's controller is unpowered | *pending* | *pending* |

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
- Onboard RGB LED near GPIO 48 (to verify in Phase 2).
- No wiring done yet.

---

## 12. Firmware and software
- None yet.
- Repo layout: `firmware/` (ESP32-S3), `relay/` (AI relay service), `docs/` (this log, photos, pinouts).
- Candidate firmware toolchains (decide in Phase 2): ESP-IDF, Arduino-ESP32, or ESPHome.

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
