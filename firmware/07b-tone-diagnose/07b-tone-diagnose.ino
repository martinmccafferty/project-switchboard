// Project Switchboard - transmit diagnosis (T-073): why is the earpiece tone crackly?
// Same wiring as 07-tone-out (PDM on GPIO 15 -> 2.2k / 10 nF -> 10 nF -> VIN). Lift the handset and listen.
// Type a letter + Enter:
//   t  sound: tone -> silence -> tone (is the crackle there even in silence?)
//   v  volume: quiet / medium / loud
//   m  format: mono <-> stereo (same sample sent to both channels)
//   r  sample rate: 16000 -> 8000 -> 48000
// Every 2 s while off-hook it prints timing: if "late writes" climbs, the ESP32 isn't keeping the
// audio fed (gaps = clicks). Hook on GPIO 4; RM low, F/R high as in 99.

#include <ESP_I2S.h>
#include <math.h>

const int SHK_PIN = 4, RM_PIN = 5, FR_PIN = 6, PDM_OUT = 15, PDM_CLK = 16, LED_PIN = 48;
const int RATES[3] = {16000, 8000, 48000};
const int16_t LEVELS[3] = {1000, 3300, 10000};
const char* LEVEL_NAMES[3] = {"quiet", "medium", "loud"};
const float TONE_HZ = 440.0f;
const int FRAMES = 256;

I2SClass i2s;
int rateIdx = 0, level = 1;
bool stereo = false, toneOn = true;
int16_t buf[FRAMES * 2];
float phase = 0;
bool offHook = false, lastRaw = false;
unsigned long rawChangedAt = 0, lastReport = 0;
unsigned long writes = 0, shortWrites = 0, lateWrites = 0, maxGapUs = 0, lastWriteUs = 0;

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }

bool startI2S() {
  i2s.end();
  i2s.setPinsPdmTx(PDM_CLK, PDM_OUT);
  bool ok = i2s.begin(I2S_MODE_PDM_TX, RATES[rateIdx], I2S_DATA_BIT_WIDTH_16BIT,
                      stereo ? I2S_SLOT_MODE_STEREO : I2S_SLOT_MODE_MONO);
  Serial.printf("PDM %s: %d Hz, %s\n", ok ? "running" : "FAILED", RATES[rateIdx], stereo ? "stereo" : "mono");
  writes = shortWrites = lateWrites = maxGapUs = 0; lastWriteUs = 0;
  return ok;
}

void setup() {
  digitalWrite(RM_PIN, LOW);  pinMode(RM_PIN, OUTPUT);  digitalWrite(RM_PIN, LOW);
  digitalWrite(FR_PIN, HIGH); pinMode(FR_PIN, OUTPUT);  digitalWrite(FR_PIN, HIGH);
  pinMode(SHK_PIN, INPUT);
  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.println("Project Switchboard - tone diagnosis (07b-tone-diagnose)");
  Serial.println("t tone/silence | v volume | m mono/stereo | r sample rate");
  startI2S();
  offHook = lastRaw = digitalRead(SHK_PIN);
  rawChangedAt = millis();
  led(0, 0, 8);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 't' || c == 'T') { toneOn = !toneOn; Serial.printf("Sound: %s\n", toneOn ? "TONE" : "SILENCE"); }
    else if (c == 'v' || c == 'V') { level = (level + 1) % 3; Serial.printf("Volume: %s\n", LEVEL_NAMES[level]); }
    else if (c == 'm' || c == 'M') { stereo = !stereo; startI2S(); }
    else if (c == 'r' || c == 'R') { rateIdx = (rateIdx + 1) % 3; startI2S(); }
  }

  bool raw = digitalRead(SHK_PIN);
  unsigned long now = millis();
  if (raw != lastRaw) { lastRaw = raw; rawChangedAt = now; }
  if (raw != offHook && now - rawChangedAt >= 30) {
    offHook = raw;
    Serial.println(offHook ? "OFF-HOOK" : "ON-HOOK");
    led(0, offHook ? 40 : 0, offHook ? 0 : 8);
  }

  const int fs = RATES[rateIdx];
  const float step = 2.0f * PI * TONE_HZ / fs;
  const int ch = stereo ? 2 : 1;
  for (int i = 0; i < FRAMES; i++) {
    int16_t v = (offHook && toneOn) ? (int16_t)(sinf(phase) * LEVELS[level]) : 0;
    phase += step;
    if (phase > 2.0f * PI) phase -= 2.0f * PI;
    for (int k = 0; k < ch; k++) buf[i * ch + k] = v;
  }
  size_t want = FRAMES * ch * sizeof(int16_t);
  unsigned long t0 = micros();
  size_t got = i2s.write((uint8_t*)buf, want);
  unsigned long t1 = micros();
  writes++;
  if (got < want) shortWrites++;
  // a buffer holds FRAMES/fs seconds of audio; if we come back much later than that, the output ran dry
  unsigned long bufUs = (unsigned long)(1000000.0 * FRAMES / fs);
  if (lastWriteUs) {
    unsigned long gap = t0 - lastWriteUs;
    if (gap > maxGapUs) maxGapUs = gap;
    if (gap > bufUs * 3 / 2 && t1 - t0 < 200) lateWrites++;
  }
  lastWriteUs = t1;

  if (offHook && now - lastReport >= 2000) {
    lastReport = now;
    Serial.printf("  timing: %lu writes, %lu short, %lu late, longest gap %lu us (buffer = %lu us)\n",
                  writes, shortWrites, lateWrites, maxGapUs, bufUs);
    maxGapUs = 0;
  }
}
