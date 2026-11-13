// Project Switchboard - Phase 4 audio (T-068): 06c = line listen with REAL averaging.
// 06/06b used analogRead(), which takes ~48 us on this core, so only one read fit in each 125 us sample
// and the averaging never ran (T-067 startup line: "averaging 1 reads per sample").
// 06c runs the ADC continuously in hardware (DMA) at 64 kHz and averages each group of 8 conversions
// (dropping the highest and lowest) into one 8 kHz sample. Type o + Enter to compare with single conversions.
// Wiring as 06: VOUT -> 100k -> 100 nF -> W (100k to 3V3, 100k to ground) -> 10k -> GPIO 7; SHK divider -> GPIO 4;
// RM -> GPIO 5 (+100k to ground); F/R -> GPIO 6. Board: ESP32S3 Dev Module; USB CDC On Boot: Enabled; 115200 baud.

#include <math.h>
#include "esp_adc/adc_continuous.h"

const int SHK_PIN = 4, RM_PIN = 5, FR_PIN = 6, LED_PIN = 48;   // audio on GPIO 7 = ADC1 channel 6
const adc_channel_t AUDIO_CH = ADC_CHANNEL_6;
const int RAW_RATE = 64000, GROUP = 8, FS = RAW_RATE / GROUP;   // 8 kHz output
const int N = 205;                                              // DTMF block (~25.6 ms)

const float ROW_HZ[4] = {697, 770, 852, 941};
const float COL_HZ[4] = {1209, 1336, 1477, 1633};
const char KEYS[4][4] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}};
float rowCoef[4], colCoef[4];

adc_continuous_handle_t adc = NULL;
uint8_t dmaBuf[1024];
int groupVals[GROUP]; int groupFill = 0;
int16_t blk[N]; int blkFill = 0;
bool averaging = true;

bool offHook = false, lastRaw = false;
unsigned long lastLevelPrint = 0, framesBad = 0;
char lastSeen = 0, reported = 0; int sameCount = 0, quietCount = 0;
String dialed = "";
long statMin = 4095, statMax = 0; double statSum = 0, statSq = 0, hpSq = 0; long statN = 0;
float hpY = 0, hpPrev = 0; const float HP_A = 0.864f;   // ~200 Hz high-pass at 8 kHz

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }

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
  // hook (once per block, ~26 ms)
  bool raw = digitalRead(SHK_PIN);
  if (raw == lastRaw && raw != offHook) {
    offHook = raw;
    if (offHook) { Serial.println("OFF-HOOK - listening"); dialed = ""; led(0, 40, 0); }
    else {
      Serial.println("ON-HOOK");
      if (dialed.length()) Serial.printf("Number dialed: %s\n", dialed.c_str());
      led(0, 0, 8);
    }
  }
  lastRaw = raw;

  for (int i = 0; i < N; i++) {
    int v = blk[i];
    if (v < statMin) statMin = v;
    if (v > statMax) statMax = v;
    statSum += v; statSq += (double)v * v; statN++;
    float x = v; hpY = HP_A * (hpY + x - hpPrev); hpPrev = x; hpSq += (double)hpY * hpY;
  }
  if (millis() - lastLevelPrint >= 1000) {
    lastLevelPrint = millis();
    double mean = statSum / statN, rms = sqrt(statSq / statN - mean * mean), hpRms = sqrt(hpSq / statN);
    const float mv = 3100.0f / 4095.0f;
    Serial.printf("  %s [%s] level: middle %4.0f mV, swing %4.0f mV p-p, rms %5.1f mV, voice-band rms %5.1f mV%s\n",
                  offHook ? "OFF-HOOK" : "on-hook ", averaging ? "avg8" : "single",
                  mean * mv, (statMax - statMin) * mv, rms * mv, hpRms * mv,
                  (statMin <= 5 || statMax >= 4090) ? "  << CLIPPING" : "");
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
    if (++quietCount >= 2) { reported = 0; led(0, 40, 0); }
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
    out = (int)((sum - mn - mx) / (GROUP - 2));          // trimmed mean of 8: spikes dropped
  } else {
    out = groupVals[0];                                   // one conversion per sample, for comparison
  }
  blk[blkFill++] = (int16_t)out;
  if (blkFill == N) { blkFill = 0; processBlock(); }
}

void setup() {
  digitalWrite(RM_PIN, LOW);  pinMode(RM_PIN, OUTPUT);  digitalWrite(RM_PIN, LOW);
  digitalWrite(FR_PIN, HIGH); pinMode(FR_PIN, OUTPUT);  digitalWrite(FR_PIN, HIGH);
  pinMode(SHK_PIN, INPUT);
  for (int i = 0; i < 4; i++) {
    rowCoef[i] = 2 * cosf(2 * PI * ROW_HZ[i] / FS);
    colCoef[i] = 2 * cosf(2 * PI * COL_HZ[i] / FS);
  }
  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.println("Project Switchboard - line listen, hardware ADC (06c-line-listen-dma)");

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
  Serial.printf("ADC running: %d kHz, %s %d conversions per 8 kHz sample. Type o + Enter to toggle.\n",
                RAW_RATE / 1000, "averaging", GROUP);
  led(0, 0, 8);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'o' || c == 'O') {
      averaging = !averaging;
      Serial.printf("Averaging %s\n", averaging ? "ON (trimmed mean of 8)" : "OFF (single conversions)");
    }
  }
  uint32_t got = 0;
  esp_err_t e = adc_continuous_read(adc, dmaBuf, sizeof(dmaBuf), &got, 50);
  if (e != ESP_OK) return;
  for (uint32_t i = 0; i + SOC_ADC_DIGI_RESULT_BYTES <= got; i += SOC_ADC_DIGI_RESULT_BYTES) {
    adc_digi_output_data_t* p = (adc_digi_output_data_t*)&dmaBuf[i];
    if (p->type2.channel != AUDIO_CH) { framesBad++; continue; }
    addConversion(p->type2.data);
  }
}
