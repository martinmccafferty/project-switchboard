# Phase 3 shopping list (2026-11-07)

**Sourcing update (2026-11-07):** DigiKey shows the AG1171 at 0 stock (backorder) and Newark quotes deliveries from 7 Jan 2027 (18-week lead time). **Symmetry Electronics** (symmetryelectronics.com, a Silvertel distributor) lists 2,282 AG1171S in stock at $8.50 each. Plan: buy the 2 × AG1171S from Symmetry, and everything else (items 2–7) from DigiKey. Avoid marketplace brokers (counterfeit risk).

Originally planned as one DigiKey order. Expected total: about **$25 plus shipping**.

| # | Qty | Part | Search DigiKey for | Why | Approx. |
|---|---|---|---|---|---|
| 1 | 2 | **Silvertel AG1171** ringing SLIC module (14-pin SIL) | `AG1171` | The "telephone exchange in a chip": powers the phone line from 5 V, rings the bell (~60 V), reports off-hook, passes audio. One spare, because it's the one part we can't proceed without and it's easy to damage while learning (e.g. driving its PD pin high) | $8.50 each |
| 2 | 2 | 470 µF, 16 V or higher, aluminum electrolytic, radial, through-hole | `470uF 16V radial electrolytic` (e.g. Panasonic EEU-FR1C471) | Required reservoir capacitor (C2) on the AG1171's power input; supplies the current bursts for ringing | < $1 each |
| 3 | 5 | 0.1 µF (100 nF) ceramic, 50 V, through-hole, 2.54 mm leads | `0.1uF 50V ceramic radial 2.54mm` | Supply decoupling and the VOUT audio coupling capacitor | pennies |
| 4 | 5 | 0.01 µF (10 nF) ceramic, 50 V, through-hole, 2.54 mm leads | `0.01uF 50V ceramic radial 2.54mm` | VIN audio coupling capacitor | pennies |
| 5 | 4 | 1N4004 rectifier diode | `1N4004` | Line protection bridge (D2–D5 in datasheet Figure 4) | pennies |
| 6 | 2 | 1N4148 signal diode | `1N4148` | Protection (D6) | pennies |
| 7 | 2 | P6KE82A TVS diode (82 V) | `P6KE82A` | Line surge/ESD clamp (D1) | < $1 each |

Small parts are bought in spares because they cost pennies and shipping is the real cost.

## Not buying (and why)
- **Audio codec board: deferred (D-14).** First try the ESP32-S3's built-in converters (ADC in, PDM/sigma-delta out) at telephone quality. If quality isn't good enough for speech recognition, buy a codec then.
- **RJ11 breakout:** cut the phone's own line cord (D-53 in the log), keeping a ~50 cm plug end.
- **Resistors, jumpers, breadboard:** already owned (starter kit).
- **Power supply:** the Mac's USB-C port is fine on the bench; a 5 V / 2 A USB-C charger is needed only for the final install.
