# Project Switchboard — Engineering Log

**Owner:** Martin McCafferty · **Engineering partner:** Claude
**Last updated:** 2026-10-30 (Log v1.4)
**Current phase:** Phase 0 — Identification & documentation

> How to use this log: it is the single source of truth between conversations. Claude updates it after every session that produces a discovery, decision, or test result. Items are numbered (C = confirmed, H = hypothesis, D = decision, Q = open question, T = test) so they can be referenced in conversation ("H-01 is now confirmed by T-003").
>
> Two copies are kept in sync: this file in the GitHub repo (`docs/engineering-log.md`, version history) and the Project Switchboard doc on claude.ai (`claude/switchboard-engineering-log.md`, read automatically by new chats).

---

## 1. Status summary

- Telephone opened, photographed, and reassembled. No electrical measurements yet.
- Architecture direction "Build the phone line, not a new phone" accepted in principle (D-01). Final commitment happens at the Phase 3 decision gate.
- GitHub repository `martinmccafferty/project-switchboard` created (private) and seeded (D-07).
- Next action: Phase 0 photo survey (Section 9, Phase 0 checklist).

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
| ESP32-S3 DevKitC-1 N16R8 (16 MB flash, 8 MB octal PSRAM) | 2 (2-pack) | Two USB-C ports; external antenna included, not connected | Main controller (one spare) |
| 830-point breadboard | 1 | Prototyping only | Prototyping |
| USB breadboard power supply (3.3 V / 5 V) | 1 | | Likely unneeded |
| 320+ component starter kit | 1 | Contents to confirm when needed | Misc. resistors/LEDs/etc. |
| Dupont jumper wires (M-F, M-M) | assorted | | Prototyping |
| Digital multimeter | 1 | Model to confirm | Testing |
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
| C-12 | Handset, speaker, microphone and other harness wires (red, black, green, yellow) are soldered directly to the main PCB; only the 9-pin and 4-pin harnesses are plug-in | P-07 | 2026-10-30 |

---

## 6. Working hypotheses

| ID | Hypothesis | Basis | How we will test | Status |
|---|---|---|---|---|
| H-01 | The "rotary" dial is an electronic keypad emulation; the phone dials with DTMF touch tones, not pulses | * and # positions (C-02) are impossible on a pulse dial; crystal (C-05) typical of DTMF generators | IC part numbers (Phase 0); later, decode tones (Phase 4) | **Strongly supported** by C-13 (HT9200A DTMF generator on board); final confirmation by decoding tones in Phase 4 |
| H-02 | The crystal is a ~3.58 MHz DTMF-type crystal | Typical for tone-dialer chips | Close-up photo of its marking | Strongly supported (HT9200A requires 3.58 MHz); P-09 still wanted |
| H-03 | Ribbon functions: HF = hands-free button, L1–L4 + KG = dial encoding, LED± = indicator light | Labels only | Only needed if architecture changes (D-04) | Parked |
| H-04 | The bell is driven by a standard ringing signal and will ring from a 1-REN SLIC | Normal analog phone design | Phase 4 ring test | Open |
| H-05 | Handset, speaker, and bell wires are soldered directly to the main PCB (only the 9-pin and 4-pin harnesses are plug-in) | Top-side photos show wires entering board | Underside photo | **Confirmed by C-12** — reinforces D-01 |
| H-06 | The phone behaves as a standard US loop-powered analog telephone | Designed for analog lines | Chip IDs; Phase 4 | Open |
| H-07 | Hook switch and hands-free button both simply take the phone "off-hook" from the line's point of view | Normal phone design | Phase 4 | Open |
| H-08 | U6 is a bridge rectifier at the line input, making the phone insensitive to line polarity | 4-pin package beside the green/red pair, typical of phone line input; supports H-06 | Chip close-up (P-08) | Open |
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
| D-06 | Do not attach the external antenna yet | Depends on which ESP32 module variant the board uses (Q-08) | 2026-10-30 | Active |
| D-07 | Code and docs live in private GitHub repo `martinmccafferty/project-switchboard`; secrets (Wi-Fi passwords, API keys) are never committed | Created early so history starts at Phase 0 | 2026-10-30 | Active |

---

## 8. Open questions

| ID | Question | Needed by |
|---|---|---|
| Q-01 | What is behind the rectangular covered panel on the base (battery compartment)? | Phase 0 |
| Q-02 | IC part numbers: U4 = HT9200A (C-13), U2 ≈ UTC1062 (C-14), U3 unmarked (C-15); U6 still to photograph | Phase 0 (mostly answered) |
| Q-03 | Does the phone have a tone/pulse setting anywhere? (Only VOLUME switch seen so far) | Phase 0–1 |
| Q-04 | Where will the AI relay run (home computer, Raspberry Pi, cloud service)? | Phase 2 |
| Q-05 | Which AI voice stack: realtime speech-to-speech API vs. speech-to-text → LLM (e.g. Claude) → text-to-speech? | Phase 2–5 |
| Q-06 | Google Home integration: ESP32 as a Matter device (good for "ring the phone" notifications); control in the other direction still unresolved | Phase 7 |
| Q-07 | Solder-free permanent assembly method (pre-made carrier board, screw terminals, etc.) | Phase 8 |
| Q-08 | ESP32 module variant: built-in PCB antenna (WROOM-1) or external-antenna-only (WROOM-1U, tiny round connector)? | Phase 2 |
| Q-09 | Which audio codec board, and is the existing USB power adequate? | Phase 3 |
| ~~Q-10~~ | ~~Does Martin have a GitHub account?~~ Answered: yes — repo created (D-07) | — |

---

## 9. Roadmap

| Phase | Scope | Purchases | Status |
|---|---|---|---|
| 0 | Photo survey & part identification; set up this log and repo | None | **In progress** |
| 1 | Simple unpowered checks to confirm the phone is a standard tone-dialing analog phone | None | Not started |
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
- [x] Hook switch identified (C-04)
- [x] Photo: underside of main PCB (P-07)
- [x] Close-ups of U2, U3, U4 (P-08a–c)
- [ ] Close-up of U6 (top-left 4-pin part)
- [ ] Close-up: crystal marking
- [ ] Photos: both sides of the green dial board
- [ ] Photo: hook-switch board and 4-pin cable route
- [ ] Photo: bell assembly (coil / striker)
- [ ] Identify what is behind the base's rectangular panel (Q-01)
- [ ] Photo: ESP32 board close-up of the module end (antenna type, Q-08) and USB port labels

---

## 10. Test log

| ID | Date | Test | Setup | Expected | Observed | Conclusion |
|---|---|---|---|---|---|---|
| — | — | No tests yet | — | — | — | — |

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

### 11.3 ESP32-S3 DevKitC-1 N16R8 — notes (general knowledge, verify against the actual board)
- Two USB-C ports: typically one labeled **USB** (the chip's native USB) and one labeled **UART/COM** (via a USB-to-serial chip). Either can power and program the board.
- "R8" = octal PSRAM, which occupies GPIO 35, 36 and 37 — avoid these pins.
- Onboard RGB LED is usually on GPIO 48 (GPIO 38 on some board revisions).
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
- **Photos:** `docs/photos/` — P-01 to P-08c committed; P-09 to P-14 wanted (plus U6 close-up). Index and shot list in `docs/photos/README.md`.

---

## 14. Change history
| Date | Version | Change |
|---|---|---|
| 2026-10-30 | v1 | Log created from handover review, photo analysis, architecture proposal; added C-04 (hook switch) and ESP32 board details from Martin |
| 2026-10-30 | v1.1 | GitHub repo created and seeded (D-07); Q-10 answered; log now mirrored in repo |
| 2026-10-30 | v1.2 | Original six photos committed as P-01–P-06; Phase 0 shot list defined as P-07–P-14 |
| 2026-10-30 | v1.3 | P-07 (PCB underside) added: C-11, C-12; H-05 confirmed; H-08, H-09 added |
| 2026-10-30 | v1.4 | Chip close-ups P-08a–c: U4 = HT9200A DTMF generator (C-13), U2 ≈ UTC1062 speech network (C-14), U3 unmarked (C-15); H-01 strongly supported; H-09 revised; H-10 added |
