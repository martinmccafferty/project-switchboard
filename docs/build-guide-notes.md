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
