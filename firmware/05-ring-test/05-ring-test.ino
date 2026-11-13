// Project Switchboard - Phase 4 (T-060): ring the phone's bell from the ESP32.
// AG1171 ringing (datasheet): RM high puts the module in ringing mode; toggling F/R at 20-25 Hz makes the
// ringing signal. RM may be high at most 33% of the time, and must go low only >10 ms after F/R is left high.
// Cadence used here: US style, 2 s ringing / 4 s silence (exactly 33%). Rings up to 4 times, or until answered.
// Wiring (D-61): SHK -> divider -> GPIO 4; RM (pos 11) -> GPIO 5, with 100 kOhm from pos 11 to the - rail so RM
// stays low if the ESP32 is unplugged; F/R (pos 12) -> GPIO 6. Shared ground.
// Serial Monitor at 115200: type r + Enter to ring, s + Enter to stop. LED: red while ringing, green off-hook.

const int SHK_PIN = 4;
const int RM_PIN  = 5;
const int FR_PIN  = 6;
const int LED_PIN = 48;

const unsigned long HALF_PERIOD_US = 25000;   // 20 Hz ringing: F/R flips every 25 ms
const unsigned long RING_ON_MS  = 2000;
const unsigned long RING_OFF_MS = 4000;
const int MAX_RINGS = 4;
const unsigned long TRIP_HIGH_MS = 60;        // SHK high this long within a 200 ms window while ringing = answered
const unsigned long DEBOUNCE_MS = 30;         // normal hook debounce outside ringing

enum Mode { IDLE, RING_ON, RING_OFF };
Mode mode = IDLE;
int ringsDone = 0;
unsigned long phaseStart = 0, lastFlip = 0;
bool frState = true;

// hook state
bool offHook = false, lastRaw = false;
unsigned long rawChangedAt = 0;
// ring-trip window
unsigned long windowStart = 0, windowHighMs = 0, lastSample = 0, burstHighMs = 0;

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }
void showIdle() { if (offHook) led(0, 40, 0); else led(0, 0, 8); }

void safeStop(const char* why) {
  digitalWrite(FR_PIN, HIGH);   // leave F/R permanently high (forward)...
  frState = true;
  delay(15);                    // ...for more than 10 ms...
  digitalWrite(RM_PIN, LOW);    // ...then leave ringing mode
  if (mode != IDLE) Serial.printf("Ringing stopped: %s\n", why);
  mode = IDLE;
  showIdle();
}

void startBurst() {
  mode = RING_ON;
  phaseStart = millis();
  lastFlip = micros();
  windowStart = millis(); windowHighMs = 0; burstHighMs = 0; lastSample = millis();
  digitalWrite(FR_PIN, HIGH); frState = true;
  digitalWrite(RM_PIN, HIGH);
  led(40, 0, 0);
  Serial.printf("Ring %d of %d...\n", ringsDone + 1, MAX_RINGS);
}

void endBurst() {
  digitalWrite(FR_PIN, HIGH); frState = true;
  delay(15);
  digitalWrite(RM_PIN, LOW);
  ringsDone++;
  Serial.printf("  (SHK was high for %lu ms during that ring)\n", burstHighMs);
  if (ringsDone >= MAX_RINGS) { mode = IDLE; Serial.println("No answer after 4 rings."); showIdle(); return; }
  mode = RING_OFF;
  phaseStart = millis();
  led(8, 0, 0);
}

void setup() {
  // Outputs to a safe state first: RM low (not ringing), F/R high (forward).
  digitalWrite(RM_PIN, LOW);  pinMode(RM_PIN, OUTPUT);  digitalWrite(RM_PIN, LOW);
  digitalWrite(FR_PIN, HIGH); pinMode(FR_PIN, OUTPUT);  digitalWrite(FR_PIN, HIGH);
  pinMode(SHK_PIN, INPUT);
  Serial.begin(115200);
  delay(1500);
  offHook = lastRaw = digitalRead(SHK_PIN);
  rawChangedAt = millis();
  showIdle();
  Serial.println();
  Serial.println("Project Switchboard - ring test (05-ring-test)");
  Serial.println("Type r + Enter to ring, s + Enter to stop.");
  Serial.printf("Handset is %s\n", offHook ? "UP" : "DOWN");
}

void loop() {
  unsigned long now = millis();
  bool raw = digitalRead(SHK_PIN);

  // serial commands
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'r' || c == 'R') {
      if (mode != IDLE) Serial.println("Already ringing.");
      else if (offHook) Serial.println("Handset is up - hang up first, then ring.");
      else { ringsDone = 0; startBurst(); }
    } else if (c == 's' || c == 'S') {
      safeStop("stopped by you");
    }
  }

  if (mode == RING_ON) {
    // 20 Hz: flip F/R every 25 ms
    unsigned long us = micros();
    if (us - lastFlip >= HALF_PERIOD_US) {
      lastFlip += HALF_PERIOD_US;
      frState = !frState;
      digitalWrite(FR_PIN, frState);
    }
    // ring trip: SHK pulses while ringing; count high time in 200 ms windows
    if (now != lastSample) {
      if (raw) { windowHighMs += now - lastSample; burstHighMs += now - lastSample; }
      lastSample = now;
    }
    if (windowHighMs >= TRIP_HIGH_MS) {
      safeStop("ANSWERED (ring trip)");
      offHook = true; lastRaw = raw; rawChangedAt = now;
      Serial.println("OFF-HOOK - handset lifted while ringing");
      showIdle();
      return;
    }
    if (now - windowStart >= 200) { windowStart = now; windowHighMs = 0; }
    if (now - phaseStart >= RING_ON_MS) endBurst();
    return;
  }

  // normal hook detection (idle, or the silent gap between rings)
  if (raw != lastRaw) { lastRaw = raw; rawChangedAt = now; }
  if (raw != offHook && now - rawChangedAt >= DEBOUNCE_MS) {
    offHook = raw;
    Serial.println(offHook ? "OFF-HOOK - handset lifted" : "ON-HOOK  - handset replaced");
    if (offHook && mode == RING_OFF) { mode = IDLE; Serial.println("Answered between rings."); }
    showIdle();
  }

  if (mode == RING_OFF && now - phaseStart >= RING_OFF_MS) startBurst();
  delay(1);
}
