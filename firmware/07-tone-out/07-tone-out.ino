// Project Switchboard - Phase 4 audio, transmit step 1 (T-070): the ESP32 speaks into the earpiece.
// While the handset is up, plays a steady 440 Hz tone. Type v + Enter to step the volume (quiet/medium/loud).
// Output (D-14, D-65): I2S in PDM mode on GPIO 15 (a fast 1-bit stream whose density follows the audio),
// smoothed by 2.2 kOhm + 10 nF to ground (row P), then 10 nF into the AG1171's VIN (pos 6).
// GPIO 16 carries the PDM clock; it is required by the driver but not wired to anything.
// Hook: SHK divider -> GPIO 4. RM -> GPIO 5 (held low), F/R -> GPIO 6 (held high). 115200 baud.

#include <ESP_I2S.h>
#include <math.h>

const int SHK_PIN = 4, RM_PIN = 5, FR_PIN = 6, PDM_OUT = 15, PDM_CLK = 16, LED_PIN = 48;
const int FS = 16000;
const float TONE_HZ = 440.0f;
const int16_t LEVELS[3] = {1000, 3300, 10000};          // about -30, -20, -10 dB below full scale
const char* LEVEL_NAMES[3] = {"quiet", "medium", "loud"};
int level = 1;

I2SClass i2s;
int16_t buf[256];
float phase = 0;
bool offHook = false, lastRaw = false;
unsigned long rawChangedAt = 0;

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }

void setup() {
  digitalWrite(RM_PIN, LOW);  pinMode(RM_PIN, OUTPUT);  digitalWrite(RM_PIN, LOW);
  digitalWrite(FR_PIN, HIGH); pinMode(FR_PIN, OUTPUT);  digitalWrite(FR_PIN, HIGH);
  pinMode(SHK_PIN, INPUT);
  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.println("Project Switchboard - tone out (07-tone-out)");
  i2s.setPinsPdmTx(PDM_CLK, PDM_OUT);
  if (!i2s.begin(I2S_MODE_PDM_TX, FS, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
    Serial.println("PDM output FAILED to start");
    led(40, 0, 0);
    while (true) delay(1000);
  }
  offHook = lastRaw = digitalRead(SHK_PIN);
  rawChangedAt = millis();
  Serial.println("PDM output running on GPIO 15. Lift the handset to hear a 440 Hz tone.");
  Serial.printf("Volume: %s (type v + Enter to change)\n", LEVEL_NAMES[level]);
  led(0, 0, 8);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'v' || c == 'V') {
      level = (level + 1) % 3;
      Serial.printf("Volume: %s\n", LEVEL_NAMES[level]);
    }
  }
  bool raw = digitalRead(SHK_PIN);
  unsigned long now = millis();
  if (raw != lastRaw) { lastRaw = raw; rawChangedAt = now; }
  if (raw != offHook && now - rawChangedAt >= 30) {
    offHook = raw;
    Serial.println(offHook ? "OFF-HOOK - playing tone" : "ON-HOOK  - silent");
    if (offHook) led(0, 40, 0); else led(0, 0, 8);
  }

  // one buffer = 256 samples = 16 ms; write() waits for room, which paces the loop
  const float step = 2.0f * PI * TONE_HZ / FS;
  for (int i = 0; i < 256; i++) {
    buf[i] = offHook ? (int16_t)(sinf(phase) * LEVELS[level]) : 0;
    phase += step;
    if (phase > 2.0f * PI) phase -= 2.0f * PI;
  }
  i2s.write((uint8_t*)buf, sizeof(buf));
}
