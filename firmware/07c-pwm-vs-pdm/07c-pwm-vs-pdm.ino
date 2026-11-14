// Project Switchboard - transmit method comparison (T-077): PDM vs PWM on the same pin and filter.
// T-076 showed the crackle comes from the PDM pattern itself (pin held steady at 0 V or 3.3 V: no crackle).
// PDM's switching pattern changes constantly with the signal; PWM switches at a fixed 78 kHz rate, which
// usually gives a much quieter result through a simple RC filter. Same wiring as 07 (+ second RC stage).
// Type a letter + Enter:
//   p  method: PDM <-> PWM
//   t  tone <-> silence
//   v  volume: quiet / medium / loud
// Hook on GPIO 4; RM low, F/R high. Tone plays only while the handset is up.

#include <ESP_I2S.h>
#include <math.h>

const int SHK_PIN = 4, RM_PIN = 5, FR_PIN = 6, OUT_PIN = 15, PDM_CLK = 16, LED_PIN = 48;
const float TONE_HZ = 440.0f;
const int16_t LEVELS[3] = {1000, 3300, 10000};          // of 32767 full scale
const char* LEVEL_NAMES[3] = {"quiet", "medium", "loud"};

// PDM
const int PDM_RATE = 16000;
I2SClass i2s;
int16_t pdmBuf[256];

// PWM: 9-bit at 62.5 kHz (falls back to 8-bit at 78 kHz), duty updated 8000 times a second.
// (10-bit at 78 kHz needs a faster LEDC clock than this core provides: "div_param=0", T-077.)
int PWM_FREQ = 62500, PWM_BITS = 9, PWM_MID = 256;
const int PWM_RATE = 8000;
const unsigned long PWM_PERIOD_US = 1000000UL / PWM_RATE;   // 125 us

bool usePwm = true, toneOn = true;
int level = 1;
float phase = 0;
bool offHook = false, lastRaw = false;
unsigned long rawChangedAt = 0, nextSampleUs = 0, lateSamples = 0, lastReport = 0;

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }

void startPdm() {
  i2s.setPinsPdmTx(PDM_CLK, OUT_PIN);
  bool ok = i2s.begin(I2S_MODE_PDM_TX, PDM_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
  Serial.printf("Method: PDM %s\n", ok ? "running (16 kHz)" : "FAILED");
}

void startPwm() {
  PWM_FREQ = 62500; PWM_BITS = 9;
  bool ok = ledcAttach(OUT_PIN, PWM_FREQ, PWM_BITS);
  if (!ok) { PWM_FREQ = 78125; PWM_BITS = 8; ok = ledcAttach(OUT_PIN, PWM_FREQ, PWM_BITS); }
  PWM_MID = 1 << (PWM_BITS - 1);
  if (ok) ledcWrite(OUT_PIN, PWM_MID);
  nextSampleUs = micros();
  lateSamples = 0;
  if (ok) Serial.printf("Method: PWM running (%d Hz, %d-bit, 8 kHz updates)\n", PWM_FREQ, PWM_BITS);
  else    Serial.println("Method: PWM FAILED");
}

void switchMethod() {
  if (usePwm) { ledcDetach(OUT_PIN); usePwm = false; startPdm(); }
  else        { i2s.end(); usePwm = true; startPwm(); }
}

void handleInputAndHook() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'p' || c == 'P') switchMethod();
    else if (c == 't' || c == 'T') { toneOn = !toneOn; Serial.printf("Sound: %s\n", toneOn ? "TONE" : "SILENCE"); }
    else if (c == 'v' || c == 'V') { level = (level + 1) % 3; Serial.printf("Volume: %s\n", LEVEL_NAMES[level]); }
  }
  bool raw = digitalRead(SHK_PIN);
  unsigned long now = millis();
  if (raw != lastRaw) { lastRaw = raw; rawChangedAt = now; }
  if (raw != offHook && now - rawChangedAt >= 30) {
    offHook = raw;
    Serial.println(offHook ? "OFF-HOOK" : "ON-HOOK");
    led(0, offHook ? 40 : 0, offHook ? 0 : 8);
  }
  if (usePwm && offHook && now - lastReport >= 2000) {
    lastReport = now;
    Serial.printf("  PWM timing: %lu late updates in the last 2 s\n", lateSamples);
    lateSamples = 0;
  }
}

int16_t nextSample(int fs) {
  int16_t v = (offHook && toneOn) ? (int16_t)(sinf(phase) * LEVELS[level]) : 0;
  phase += 2.0f * PI * TONE_HZ / fs;
  if (phase > 2.0f * PI) phase -= 2.0f * PI;
  return v;
}

void setup() {
  digitalWrite(RM_PIN, LOW);  pinMode(RM_PIN, OUTPUT);  digitalWrite(RM_PIN, LOW);
  digitalWrite(FR_PIN, HIGH); pinMode(FR_PIN, OUTPUT);  digitalWrite(FR_PIN, HIGH);
  pinMode(SHK_PIN, INPUT);
  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.println("Project Switchboard - PWM vs PDM (07c-pwm-vs-pdm)");
  Serial.println("p method PDM/PWM | t tone/silence | v volume");
  startPwm();
  offHook = lastRaw = digitalRead(SHK_PIN);
  rawChangedAt = millis();
  led(0, 0, 8);
}

void loop() {
  handleInputAndHook();
  if (usePwm) {
    // 400 samples (50 ms) per pass, paced by the microsecond clock
    for (int i = 0; i < 400; i++) {
      while ((long)(micros() - nextSampleUs) < 0) {}
      if ((long)(micros() - nextSampleUs) > (long)PWM_PERIOD_US) lateSamples++;
      nextSampleUs += PWM_PERIOD_US;
      int16_t v = nextSample(PWM_RATE);
      int duty = PWM_MID + (int)((long)v * (PWM_MID - 1) / 32767);
      ledcWrite(OUT_PIN, duty);
    }
    if ((long)(micros() - nextSampleUs) > 5000) nextSampleUs = micros();   // resync after a long pause
  } else {
    for (int i = 0; i < 256; i++) pdmBuf[i] = nextSample(PDM_RATE);
    i2s.write((uint8_t*)pdmBuf, sizeof(pdmBuf));
  }
}
