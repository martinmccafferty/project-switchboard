# Build-guide notes (raw material for the public how-to)

Martin intends to publish a step-by-step guide so others can build the same phone. This file collects the
practical lessons and gotchas as we hit them, so the final guide is easy to write. Keep entries short.

## Parts and sourcing
- Silvertel AG1171 (ringing SLIC) is often backordered at DigiKey/Newark (Nov 2026: deliveries from Jan 2027).
  Symmetry Electronics / Braemac (americas.braemac.com) had stock at list price and sells singles.
  Avoid marketplace brokers (counterfeit risk).
- Small support parts (470 µF cap, 0.1 µF / 0.01 µF ceramics, 1N4004, 1N4148, P6KE82A) are cheap; buy spares.
- Shipping often costs as much as the parts; consolidate orders.

## The phone (TelPal 301 / MS-301H)
- Looks rotary, but the dial is an optical encoder that sends **touch tones** (HT9200A chip, 3.579 MHz crystal).
- Handset, speaker and bell wires are soldered to the main board, so the reversible approach is to treat the
  phone as stock and feed it a phone line from the outside.
- A multimeter can't show off-hook on this phone: its electronic hook circuit doesn't conduct at meter voltages.
- RJ11 plug contacts are recessed; meter probes won't reach them. Thin Dupont pins can.

## ESP32-S3 dev board (S3-N16R8, two USB-C ports)
- Arduino IDE 2 + "esp32 by Espressif Systems" core; board setting: **ESP32S3 Dev Module**.
- Use the port labeled **USB** (native, no driver needed on a Mac).
- First upload may need manual mode: hold BOOT, tap RST, release BOOT; the port name then changes, so re-select it.
- Set **Tools → USB CDC On Boot → Enabled** for Serial Monitor output (115200 baud); after that, uploads worked
  without the buttons.
- Onboard RGB LED is on GPIO 48; drive it with `rgbLedWrite(48, r, g, b)`.
- Keep Wi-Fi credentials in a `secrets.h` tab that's excluded from git.

## Wi-Fi and relay
- The ESP32 needs 2.4 GHz; a dual-band single-name network works fine.
- Relay: Node.js + `ws` WebSocket server on the computer; the board uses the "WebSockets" library by Markus Sattler.
- macOS may ask to allow "node" to accept incoming connections; click Allow.
- Streaming 16 kHz 16-bit mono audio (256 kbit/s) over Wi-Fi to a relay on the home network: zero loss, but frames arrive in bursts (worst gap ~130 ms). Plan for a ~150–200 ms playout buffer.
- The ESP32 can be unplugged at any time (no shutdown needed); the last uploaded sketch runs again on next power-up. Just don't unplug mid-upload.
- Don't try to strip a phone line cord: its wires are tinsel (metal ribbon round a thread) with clear insulation and are nearly impossible to strip or burn clean. Use an RJ11 jack with screw terminals (keystone jack or breakout board) and clamp Dupont pins under the screws.
- Multimeter: black probe in COM, red in VΩmA for everything except large currents (10A socket).
- Kit resistors may use 5-band (1%) colour codes: 10 kΩ is brown, black, black, red, brown, not the familiar brown, black, orange. When in doubt, measure (20k Ω range: 10 kΩ reads ~10.0). Don't confuse the 10 Ω and 10 kΩ boxes.
- The AG1171 has no pin-1 marking and its pins come in two groups of 7 with a gap. Pin 1 (RING) is the end **away** from the round coil; the coil end is pin 14 (PD), then +5 V, then GND. Check: Ω between the 10th pin from the coil (SHK) and the 2nd (+5 V) reads ~10 kΩ.
- When probing, don't hold the probe tips or pins with your fingers: readings go unstable.
- Many 830-hole breadboards split their power rails halfway along (a gap in the printed red/blue lines). Bridge + to + and − to − across the break, and beep-test the rails before powering anything.
- On these ESP32-S3 dev boards the "5Vin" pin is an input only: it won't supply USB 5 V to a breadboard (reads ~2.35 V floating). Power the line module from a breadboard power module instead.
