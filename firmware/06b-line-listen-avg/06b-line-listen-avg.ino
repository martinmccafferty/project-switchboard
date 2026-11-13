// Project Switchboard - Phase 4 audio (T-066): 06b = 06-line-listen plus noise averaging. Use this one.
// AG1171 VOUT (pos 5) -> 100 kOhm -> row T -> 100 nF -> row W (the 100k + bias network divide the level by ~3, T-062) (biased to ~1.65 V by 100k to ESP32 3V3 and 100k to ground)
// -> 10 kOhm -> GPIO 7 (ADC1). While off-hook it prints the audio level once a second and decodes
// touch-tone (DTMF) digits from the phone's dial. Levels also print on-hook (the noise floor with no call). Read-only on the line: no audio is sent yet.
// Board: ESP32S3 Dev Module; USB CDC On Boot: Enabled. Serial Monitor at 115200.
// Noise reduction (T-065): each 8 kHz sample can be the trimmed average of several quick ADC reads
// (drop the highest and lowest, average the rest). Type o + Enter to switch it on/off and compare.
// "voice-band rms" removes everything below ~200 Hz (hum, drift), which is what speech recognition would hear.
// Wiring otherwise as 05-ring-test (SHK -> divider -> GPIO 4; RM -> GPIO 5 + 100k to ground; F/R -> GPIO 6).

#include <math.h>

const int SHK_PIN = 4, RM_PIN = 5, FR_PIN = 6, AUDIO_PIN = 7, LED_PIN = 48;
const int FS = 8000;              // samples per second (telephone rate)
const int N = 205;                // samples per block (~25.6 ms), the classic DTMF Goertzel size
const unsigned long PERIOD_US = 1000000UL / FS;

const float ROW_HZ[4] = {697, 770, 852, 941};
const float COL_HZ[4] = {1209, 1336, 1477, 1633};
const char KEYS[4][4] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}};
float rowCoef[4], colCoef[4];

int16_t buf[N];
bool oversample = true;
int readsPerSample = 1;          // measured in setup()
float hpY = 0, hpPrev = 0;       // ~200 Hz high-pass state
const float HP_A = 0.864f;       // RC/(RC+dt) for fc = 200 Hz at 8 kHz
double hpSq = 0;
bool offHook = false, lastRaw = false;
unsigned long rawChangedAt = 0, lastLevelPrint = 0;
char lastSeen = 0, reported = 0;
int sameCount = 0, quietCount = 0;
String dialed = "";
// level stats accumulated over ~1 s
long statMin = 4095, statMax = 0; double statSum = 0, statSq = 0; long statN = 0;

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }

float goertzel(const float* x, float coef) {
  float s1 = 0, s2 = 0;
  for (int i = 0; i < N; i++) { float s = x[i] + coef * s1 - s2; s2 = s1; s1 = s; }
  return s1 * s1 + s2 * s2 - coef * s1 * s2;   // power at that frequency
}

char detectDigit() {
  static float x[N];
  double mean = 0;
  for (int i = 0; i < N; i++) mean += buf[i];
  mean /= N;
  double energy = 0;
  for (int i = 0; i < N; i++) { x[i] = buf[i] - mean; energy += x[i] * x[i]; }
  float rms = sqrt(energy / N);
  if (rms < 15) return 0;                       // too quiet to be a tone (ADC counts)
  float norm = 2.0f / (N * energy);             // ~ fraction of the block's energy at a frequency
  int br = 0, bc = 0; float r[4], c[4];
  for (int i = 0; i < 4; i++) {
    r[i] = goertzel(x, rowCoef[i]) * norm;
    c[i] = goertzel(x, colCoef[i]) * norm;
    if (r[i] > r[br]) br = i;
    if (c[i] > c[bc]) bc = i;
  }
  if (r[br] < 0.12f || c[bc] < 0.12f || r[br] + c[bc] < 0.55f) return 0;   // not two clean tones
  for (int i = 0; i < 4; i++) {                 // the winners must clearly beat the others
    if (i != br && r[i] * 4 > r[br]) return 0;
    if (i != bc && c[i] * 4 > c[bc]) return 0;
  }
  return KEYS[br][bc];
}

void setup() {
  digitalWrite(RM_PIN, LOW);  pinMode(RM_PIN, OUTPUT);  digitalWrite(RM_PIN, LOW);
  digitalWrite(FR_PIN, HIGH); pinMode(FR_PIN, OUTPUT);  digitalWrite(FR_PIN, HIGH);
  pinMode(SHK_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(AUDIO_PIN, ADC_11db);  // 0 to ~3.1 V
  for (int i = 0; i < 4; i++) {
    rowCoef[i] = 2 * cosf(2 * PI * ROW_HZ[i] / FS);
    colCoef[i] = 2 * cosf(2 * PI * COL_HZ[i] / FS);
  }
  // how many ADC reads fit comfortably in one 125 us sample period?
  unsigned long t0 = micros();
  for (int i = 0; i < 200; i++) analogRead(AUDIO_PIN);
  float readUs = (micros() - t0) / 200.0f;
  readsPerSample = (int)((PERIOD_US * 0.7f) / readUs);
  if (readsPerSample < 1) readsPerSample = 1;
  if (readsPerSample > 16) readsPerSample = 16;
  Serial.begin(115200);
  delay(1500);
  Serial.printf("One ADC read takes %.1f us; averaging %d reads per sample (type o + Enter to toggle)\n", readUs, readsPerSample);
  offHook = lastRaw = digitalRead(SHK_PIN);
  Serial.println();
  Serial.println("Project Switchboard - line listen WITH AVERAGING (06b-line-listen-avg)");
  Serial.println("Levels print once a second. Lift the handset, then talk or dial.");
  led(0, 0, 8);
}

void loop() {
  // one block of N samples at 8 kHz
  unsigned long t = micros();
  for (int i = 0; i < N; i++) {
    while (micros() - t < PERIOD_US) {}
    t += PERIOD_US;
    if (!oversample || readsPerSample < 3) {
      buf[i] = analogRead(AUDIO_PIN);
    } else {
      long sum = 0; int mn = 4095, mx = 0;
      for (int k = 0; k < readsPerSample; k++) {
        int v = analogRead(AUDIO_PIN);
        sum += v; if (v < mn) mn = v; if (v > mx) mx = v;
      }
      buf[i] = (int16_t)((sum - mn - mx) / (readsPerSample - 2));   // trimmed mean: spikes dropped
    }
  }
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'o' || c == 'O') {
      oversample = !oversample;
      Serial.printf("Averaging %s\n", oversample ? "ON" : "OFF (single reads)");
    }
  }

  // hook (checked once per block, ~26 ms, which is also our debounce)
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

  // level statistics (on-hook too: shows the noise floor with the phone idle)
  for (int i = 0; i < N; i++) {
    if (buf[i] < statMin) statMin = buf[i];
    if (buf[i] > statMax) statMax = buf[i];
    statSum += buf[i]; statSq += (double)buf[i] * buf[i]; statN++;
    float x = buf[i];
    hpY = HP_A * (hpY + x - hpPrev); hpPrev = x;
    hpSq += (double)hpY * hpY;
  }
  if (millis() - lastLevelPrint >= 1000) {
    lastLevelPrint = millis();
    double mean = statSum / statN;
    double rms = sqrt(statSq / statN - mean * mean);
    const float mvPerCount = 3100.0f / 4095.0f;
    double hpRms = sqrt(hpSq / statN);
    Serial.printf("  %s [%s] level: middle %4.0f mV, swing %4.0f mV p-p, rms %5.1f mV, voice-band rms %5.1f mV%s\n",
                  offHook ? "OFF-HOOK" : "on-hook ", oversample ? "avg" : "single",
                  mean * mvPerCount, (statMax - statMin) * mvPerCount, rms * mvPerCount, hpRms * mvPerCount,
                  (statMin <= 5 || statMax >= 4090) ? "  << CLIPPING" : "");
    statMin = 4095; statMax = 0; statSum = statSq = 0; statN = 0; hpSq = 0;
  }
  if (!offHook) return;

  // DTMF: a digit counts after 2 matching blocks (~50 ms); a new one needs a gap first
  char d = detectDigit();
  if (d) {
    if (d == lastSeen) sameCount++; else { lastSeen = d; sameCount = 1; }
    quietCount = 0;
    if (sameCount == 2 && d != reported) {
      reported = d;
      dialed += d;
      Serial.printf("DIGIT: %c   (so far: %s)\n", d, dialed.c_str());
      led(40, 30, 0);
    }
  } else {
    lastSeen = 0; sameCount = 0;
    if (++quietCount >= 2) { reported = 0; led(0, 40, 0); }
  }
}
