// Project Switchboard - 99-regression: "everything we've built so far", rerun after any rewiring or change.
// Version 1 (2026-11-14) covers: hook detection (04), ringing + ring trip (05), line listening with
// hardware-ADC averaging, levels and DTMF digit decoding (06c). Add each new verified feature here (D-66).
//
// Serial Monitor at 115200. Commands (type the letter + Enter):
//   r  ring (US cadence 2 s on / 4 s off, up to 4 rings; stops when answered)
//   s  stop ringing
//   l  levels on/off (audio level once a second)
//   o  averaging on/off (compare the ADC noise with single conversions)
//   ?  show this list and the checklist
//
// Wiring (D-60, D-61, D-63, D-64): SHK -> 10k -> row Z -> 100k -> ground; row Z -> GPIO 4.
// RM (pos 11) -> GPIO 5, with 100k from pos 11 to ground. F/R (pos 12) -> GPIO 6.
// VOUT (pos 5) -> 100k -> 100 nF -> row W (100k to ESP32 3V3, 100k to ground) -> 10k -> GPIO 7.
// ESP32 GND -> breadboard ground. ESP32 3V3 goes only to the bias resistor.
// LED: dim blue idle, green off-hook, red ringing, yellow flash on each digit.

#include <math.h>
#include "esp_adc/adc_continuous.h"
#include "esp_timer.h"

const char* VERSION = "99-regression v1: hook, ring, listen + DTMF";
const int SHK_PIN = 4, RM_PIN = 5, FR_PIN = 6, LED_PIN = 48;   // audio on GPIO 7 = ADC1 channel 6
const adc_channel_t AUDIO_CH = ADC_CHANNEL_6;

// ---------- ringing (D-62) ----------
const unsigned long RING_ON_MS = 2000, RING_OFF_MS = 4000;
const int MAX_RINGS = 4;
const unsigned long TRIP_HIGH_MS = 60;     // SHK high this long within 200 ms while ringing = answered
const unsigned long DEBOUNCE_MS = 30;
enum Mode { IDLE, RING_ON, RING_OFF };
Mode mode = IDLE;
int ringsDone = 0;
unsigned long phaseStart = 0, windowStart = 0, windowHighMs = 0, burstHighMs = 0, lastSample = 0;
esp_timer_handle_t frTimer;
volatile bool frState = true;

// ---------- hook ----------
bool offHook = false, lastRaw = false;
unsigned long rawChangedAt = 0;

// ---------- listening (D-63, D-64) ----------
const int RAW_RATE = 64000, GROUP = 8, FS = RAW_RATE / GROUP;  // 8 kHz
const int N = 205;
const float ROW_HZ[4] = {697, 770, 852, 941};
const float COL_HZ[4] = {1209, 1336, 1477, 1633};
const char KEYS[4][4] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}};
float rowCoef[4], colCoef[4];
adc_continuous_handle_t adc = NULL;
uint8_t dmaBuf[1024];
int groupVals[GROUP]; int groupFill = 0;
int16_t blk[N]; int blkFill = 0;
bool averaging = true, showLevels = true;
unsigned long lastLevelPrint = 0;
char lastSeen = 0, reported = 0; int sameCount = 0, quietCount = 0;
String dialed = "";
long statMin = 4095, statMax = 0; double statSum = 0, statSq = 0, hpSq = 0; long statN = 0;
float hpY = 0, hpPrev = 0; const float HP_A = 0.864f;

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }
void showIdle() { if (offHook) led(0, 40, 0); else led(0, 0, 8); }

void printHelp() {
  Serial.println("Commands: r ring | s stop | l levels on/off | o averaging on/off | ? help");
  Serial.println("Checklist: 1) handset down: on-hook levels ~10 mV voice-band [avg8]");
  Serial.println("           2) lift/replace handset and press HANDS FREE: OFF-HOOK / ON-HOOK each time");
  Serial.println("           3) off-hook: dial digits -> DIGIT lines; hang up -> 'Number dialed'");
  Serial.println("           4) r with handset down: bell rings 2 s on / 4 s off, 'SHK high 0 ms' per ring");
  Serial.println("           5) r, then lift while the bell sounds: 'ANSWERED (ring trip)', bell stops");
}

// ===== ringing =====
void frToggle(void*) { frState = !frState; digitalWrite(FR_PIN, frState); }

void ringOutputsSafe() {
  esp_timer_stop(frTimer);                 // harmless if already stopped
  digitalWrite(FR_PIN, HIGH); frState = true;
  delay(15);                               // F/R high > 10 ms before RM goes low (datasheet)
  digitalWrite(RM_PIN, LOW);
}

void startBurst() {
  mode = RING_ON;
  phaseStart = windowStart = lastSample = millis();
  windowHighMs = burstHighMs = 0;
  digitalWrite(FR_PIN, HIGH); frState = true;
  digitalWrite(RM_PIN, HIGH);
  esp_timer_start_periodic(frTimer, 25000);  // flip F/R every 25 ms = 20 Hz ringing
  led(40, 0, 0);
  Serial.printf("Ring %d of %d...\n", ringsDone + 1, MAX_RINGS);
}

void endBurst() {
  ringOutputsSafe();
  ringsDone++;
  Serial.printf("  (SHK was high for %lu ms during that ring)\n", burstHighMs);
  if (ringsDone >= MAX_RINGS) { mode = IDLE; Serial.println("No answer after 4 rings."); showIdle(); return; }
  mode = RING_OFF;
  phaseStart = millis();
  led(8, 0, 0);
}

void stopRinging(const char* why) {
  bool wasRinging = (mode != IDLE);
  ringOutputsSafe();
  mode = IDLE;
  if (wasRinging) Serial.printf("Ringing stopped: %s\n", why);
  showIdle();
}

// ===== listening =====
float goertzel(const float* x, float coef) {
  float s1 = 0, s2 = 0;
  for (int i = 0; i < N; i++) { float s = x[i] + coef * s1 - s2; s2 = s1; s1 = s; }
  return s1 * s1 + s2 * s2 - coef * s1 * s2;
}

char detectDigit() {
  static float x[N];
  double mean = 0;
  for (int i = 0; i < N; i++) mean += blk[i];
  mean /= N;
  double energy = 0;
  for (int i = 0; i < N; i++) { x[i] = blk[i] - mean; energy += x[i] * x[i]; }
  if (sqrt(energy / N) < 15) return 0;
  float norm = 2.0f / (N * energy);
  int br = 0, bc = 0; float r[4], c[4];
  for (int i = 0; i < 4; i++) {
    r[i] = goertzel(x, rowCoef[i]) * norm; c[i] = goertzel(x, colCoef[i]) * norm;
    if (r[i] > r[br]) br = i;
    if (c[i] > c[bc]) bc = i;
  }
  if (r[br] < 0.12f || c[bc] < 0.12f || r[br] + c[bc] < 0.55f) return 0;
  for (int i = 0; i < 4; i++) {
    if (i != br && r[i] * 4 > r[br]) return 0;
    if (i != bc && c[i] * 4 > c[bc]) return 0;
  }
  return KEYS[br][bc];
}

void processBlock() {
  if (mode != IDLE) return;                // ignore audio while ringing
  for (int i = 0; i < N; i++) {
    int v = blk[i];
    if (v < statMin) statMin = v;
    if (v > statMax) statMax = v;
    statSum += v; statSq += (double)v * v; statN++;
    float x = v; hpY = HP_A * (hpY + x - hpPrev); hpPrev = x; hpSq += (double)hpY * hpY;
  }
  if (millis() - lastLevelPrint >= 1000) {
    lastLevelPrint = millis();
    if (showLevels && statN > 0) {
      double mean = statSum / statN, rms = sqrt(statSq / statN - mean * mean), hpRms = sqrt(hpSq / statN);
      const float mv = 3100.0f / 4095.0f;
      Serial.printf("  %s [%s] level: middle %4.0f mV, swing %4.0f mV p-p, rms %5.1f mV, voice-band rms %5.1f mV%s\n",
                    offHook ? "OFF-HOOK" : "on-hook ", averaging ? "avg8" : "single",
                    mean * mv, (statMax - statMin) * mv, rms * mv, hpRms * mv,
                    (statMin <= 5 || statMax >= 4090) ? "  << CLIPPING" : "");
    }
    statMin = 4095; statMax = 0; statSum = statSq = hpSq = 0; statN = 0;
  }
  if (!offHook) return;

  char d = detectDigit();
  if (d) {
    if (d == lastSeen) sameCount++; else { lastSeen = d; sameCount = 1; }
    quietCount = 0;
    if (sameCount == 2 && d != reported) {
      reported = d; dialed += d;
      Serial.printf("DIGIT: %c   (so far: %s)\n", d, dialed.c_str());
      led(40, 30, 0);
    }
  } else {
    lastSeen = 0; sameCount = 0;
    if (++quietCount >= 2) { reported = 0; if (offHook) led(0, 40, 0); }
  }
}

void addConversion(int v) {
  groupVals[groupFill++] = v;
  if (groupFill < GROUP) return;
  groupFill = 0;
  int out;
  if (averaging) {
    long sum = 0; int mn = 4095, mx = 0;
    for (int k = 0; k < GROUP; k++) { int g = groupVals[k]; sum += g; if (g < mn) mn = g; if (g > mx) mx = g; }
    out = (int)((sum - mn - mx) / (GROUP - 2));
  } else {
    out = groupVals[0];
  }
  blk[blkFill++] = (int16_t)out;
  if (blkFill == N) { blkFill = 0; processBlock(); }
}

// ===== hook =====
void hookChanged() {
  if (offHook) {
    Serial.println("OFF-HOOK - handset lifted (or HANDS FREE)");
    dialed = ""; reported = 0; lastSeen = 0; sameCount = 0;
  } else {
    Serial.println("ON-HOOK  - handset replaced");
    if (dialed.length()) Serial.printf("Number dialed: %s\n", dialed.c_str());
    dialed = "";
  }
  showIdle();
}

// ===== setup / loop =====
void setup() {
  digitalWrite(RM_PIN, LOW);  pinMode(RM_PIN, OUTPUT);  digitalWrite(RM_PIN, LOW);
  digitalWrite(FR_PIN, HIGH); pinMode(FR_PIN, OUTPUT);  digitalWrite(FR_PIN, HIGH);
  pinMode(SHK_PIN, INPUT);
  for (int i = 0; i < 4; i++) {
    rowCoef[i] = 2 * cosf(2 * PI * ROW_HZ[i] / FS);
    colCoef[i] = 2 * cosf(2 * PI * COL_HZ[i] / FS);
  }
  esp_timer_create_args_t ta = {};
  ta.callback = &frToggle;
  ta.name = "fr";
  esp_timer_create(&ta, &frTimer);

  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.println("==============================================");
  Serial.printf("Project Switchboard - %s\n", VERSION);
  Serial.println("==============================================");

  adc_continuous_handle_cfg_t hcfg = {};
  hcfg.max_store_buf_size = 8192;
  hcfg.conv_frame_size = sizeof(dmaBuf);
  esp_err_t e = adc_continuous_new_handle(&hcfg, &adc);
  adc_digi_pattern_config_t pat = {};
  pat.atten = ADC_ATTEN_DB_12;
  pat.channel = AUDIO_CH;
  pat.unit = ADC_UNIT_1;
  pat.bit_width = SOC_ADC_DIGI_MAX_BITWIDTH;
  adc_continuous_config_t cfg = {};
  cfg.sample_freq_hz = RAW_RATE;
  cfg.conv_mode = ADC_CONV_SINGLE_UNIT_1;
  cfg.format = ADC_DIGI_OUTPUT_FORMAT_TYPE2;
  cfg.pattern_num = 1;
  cfg.adc_pattern = &pat;
  if (e == ESP_OK) e = adc_continuous_config(adc, &cfg);
  if (e == ESP_OK) e = adc_continuous_start(adc);
  if (e != ESP_OK) {
    Serial.printf("ADC start FAILED: %s\n", esp_err_to_name(e));
    led(40, 0, 0);
    while (true) delay(1000);
  }
  offHook = lastRaw = digitalRead(SHK_PIN);
  rawChangedAt = millis();
  Serial.printf("Listening: %d kHz ADC, averaging %d per sample. Handset is %s.\n",
                RAW_RATE / 1000, GROUP, offHook ? "UP" : "DOWN");
  printHelp();
  showIdle();
}

void loop() {
  // commands
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'r' || c == 'R') {
      if (mode != IDLE) Serial.println("Already ringing.");
      else if (offHook) Serial.println("Handset is up - hang up first, then ring.");
      else { ringsDone = 0; startBurst(); }
    } else if (c == 's' || c == 'S') {
      stopRinging("stopped by you");
    } else if (c == 'l' || c == 'L') {
      showLevels = !showLevels;
      Serial.printf("Levels %s\n", showLevels ? "ON" : "OFF");
    } else if (c == 'o' || c == 'O') {
      averaging = !averaging;
      Serial.printf("Averaging %s\n", averaging ? "ON (trimmed mean of 8)" : "OFF (single conversions)");
    } else if (c == '?' || c == 'h' || c == 'H') {
      printHelp();
    }
  }

  // audio (always drain the ADC; blocks are ignored while ringing)
  uint32_t got = 0;
  if (adc_continuous_read(adc, dmaBuf, sizeof(dmaBuf), &got, 10) == ESP_OK) {
    for (uint32_t i = 0; i + SOC_ADC_DIGI_RESULT_BYTES <= got; i += SOC_ADC_DIGI_RESULT_BYTES) {
      adc_digi_output_data_t* p = (adc_digi_output_data_t*)&dmaBuf[i];
      if (p->type2.channel == AUDIO_CH) addConversion(p->type2.data);
    }
  }

  unsigned long now = millis();
  bool raw = digitalRead(SHK_PIN);

  if (mode == RING_ON) {
    // ring trip: SHK pulses while ringing; count high time in 200 ms windows
    if (raw) { windowHighMs += now - lastSample; burstHighMs += now - lastSample; }
    lastSample = now;
    if (windowHighMs >= TRIP_HIGH_MS) {
      stopRinging("ANSWERED (ring trip)");
      offHook = true; lastRaw = raw; rawChangedAt = now;
      Serial.println("OFF-HOOK - handset lifted while ringing");
      dialed = "";
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
    if (offHook && mode == RING_OFF) { mode = IDLE; Serial.println("Answered between rings."); }
    hookChanged();
  }
  if (mode == RING_OFF && now - phaseStart >= RING_OFF_MS) startBurst();
}
