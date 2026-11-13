// Project Switchboard - Phase 4 (T-059): the ESP32 sees the handset lift.
// Reads the AG1171's SHK (off-hook) signal through the 10 kOhm + 100 kOhm divider (T-058)
// and reports every change on the Serial Monitor. No Wi-Fi, nothing driven: GPIO 4 is input only.
// Board: ESP32S3 Dev Module; USB CDC On Boot: Enabled. Serial Monitor at 115200 baud.
// LED: green = handset up (off-hook), dim blue = handset down (on-hook).

const int SHK_PIN = 4;          // divider midpoint (row Z) -> GPIO 4. Never connect SHK directly.
const int LED_PIN = 48;
const unsigned long DEBOUNCE_MS = 30;   // ignore contact bounce shorter than this

bool offHook = false;           // last confirmed state
bool lastRaw = false;
unsigned long rawChangedAt = 0;
unsigned long stateSince = 0;
unsigned long lifts = 0;

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }

void showState() {
  if (offHook) led(0, 40, 0); else led(0, 0, 8);
}

void setup() {
  Serial.begin(115200);
  delay(1500);                  // give the Serial Monitor time to attach
  pinMode(SHK_PIN, INPUT);      // plain input: the divider sets the level, no internal pull resistor
  offHook = lastRaw = digitalRead(SHK_PIN);
  stateSince = rawChangedAt = millis();
  showState();
  Serial.println();
  Serial.println("Project Switchboard - hook detection (04-hook-detect)");
  Serial.printf("Starting state: %s\n", offHook ? "OFF-HOOK (handset up)" : "ON-HOOK (handset down)");
}

void loop() {
  bool raw = digitalRead(SHK_PIN);
  unsigned long now = millis();
  if (raw != lastRaw) { lastRaw = raw; rawChangedAt = now; }

  if (raw != offHook && now - rawChangedAt >= DEBOUNCE_MS) {
    unsigned long heldMs = now - stateSince;
    offHook = raw;
    stateSince = now;
    if (offHook) {
      lifts++;
      Serial.printf("[%7.1f s] OFF-HOOK  - handset lifted (lift #%lu; it was down %.1f s)\n",
                    now / 1000.0, lifts, heldMs / 1000.0);
    } else {
      Serial.printf("[%7.1f s] ON-HOOK   - handset replaced (it was up %.1f s)\n",
                    now / 1000.0, heldMs / 1000.0);
    }
    showState();
  }
  delay(1);
}
