// Project Switchboard - 08-first-call (T-084): the real phone talks to the exchange.
// Lift the handset: the relay's dial tone plays in the earpiece. Dial 0: Doris answers. Talk to her.
// Protocol (relay/switchboard.mjs): binary 16 kHz 16-bit mono PCM, 20 ms frames, both ways;
// text {"type":"offhook"|"onhook"} and {"type":"dial","digits":"0"} to the relay; {"type":"status",...} back.
// Half duplex for now: while the relay is talking, the microphone is muted (the AG1171 echoes some of what we
// play back into what we hear, Q-24, and the operator would otherwise hear herself).
// Ringing (D-62): the relay's {"type":"ring"} rings the brass bell (2 s on / 4 s off) until answered or
// {"type":"stop_ring"}; lifting the handset (even mid-ring) answers and tells the relay "offhook".
// Board: ESP32S3 Dev Module; USB CDC On Boot: Enabled; 115200 baud. Library: "WebSockets" by Markus Sattler.
// Wiring as 99-regression. Commands: v earpiece volume, m microphone gain, ? status.
// Interference diagnosis (T-085): t = local test tone instead of the relay's audio (same level, Wi-Fi still on);
// z = PWM resting point 50% <-> 12.5% (T-089: supply noise rides on the PWM in proportion to its duty);
// g = microphone noise gate on/off; w = Wi-Fi radio off/on (use with t); p = Wi-Fi transmit power step (19.5 / 11 / 8.5 / 5 / 2 dBm). While off-hook, every 2 s: playback underruns and queue depth.

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <math.h>
#include "esp_adc/adc_continuous.h"
#include "esp_timer.h"
#include "secrets.h"

const int SHK_PIN = 4, RM_PIN = 5, FR_PIN = 6, TX_PIN = 15, LED_PIN = 48;
const adc_channel_t AUDIO_CH = ADC_CHANNEL_6;   // GPIO 7
const int RATE = 16000, FRAME = 320;            // relay format: 16 kHz, 20 ms

// ---------- speaking: PWM duty set by a 16 kHz timer interrupt from a queue (D-68, D-69) ----------
int pwmBits = 9, pwmMid = 256, pwmFreq = 62500;
const int PQ = 8192;                            // 512 ms
volatile int16_t pq[PQ];
volatile uint32_t pqHead = 0, pqTail = 0;
volatile bool primed = false;
volatile int pwmIdle = 256;      // resting duty (silence); 50% by default, 'z' lowers it to 12.5%
volatile uint32_t underruns = 0;
volatile uint32_t lastIsrCycles = 0, maxIsrGap = 0;   // timing check (T-087): longest gap between ticks, CPU cycles
bool localTone = false, wifiOn = true;
const wifi_power_t TXP[5] = {WIFI_POWER_19_5dBm, WIFI_POWER_11dBm, WIFI_POWER_8_5dBm, WIFI_POWER_5dBm, WIFI_POWER_2dBm};
const char* TXP_NAMES[5] = {"19.5 dBm (default)", "11 dBm", "8.5 dBm", "5 dBm", "2 dBm"};
int txp = 0;
float lt350 = 0, lt440 = 0;
unsigned long lastStats = 0;
hw_timer_t* txTimer = NULL;
const float EAR_GAINS[3] = {0.12f, 0.25f, 0.5f};
const char* EAR_NAMES[3] = {"quiet", "medium", "loud"};
int earLevel = 1;

void onTx() {
  uint32_t cc = ESP.getCycleCount();
  if (lastIsrCycles) { uint32_t gap = cc - lastIsrCycles; if (gap > maxIsrGap) maxIsrGap = gap; }
  lastIsrCycles = cc;
  static uint8_t skip = 0;
  uint32_t h = pqHead, t = pqTail;
  uint32_t n = (h - t) & (PQ - 1);
  // keep the delay short: above 150 ms queued, quietly drop 1 sample in 40 (2.5% faster, not audible as a click)
  if (primed && n > 2400 && ++skip >= 40) { skip = 0; t = (t + 1) & (PQ - 1); n--; pqTail = t; }
  int16_t v = 0;
  if (!primed) { if (n >= 1600) primed = true; }          // wait for 100 ms of audio before starting
  if (primed) {
    if (n == 0) { primed = false; underruns++; }           // ran dry: rebuffer (a gap = a click)
    else { v = pq[t]; pqTail = (t + 1) & (PQ - 1); }
  }
  int d = pwmIdle + (((int32_t)v * (pwmMid - 1)) >> 15);
  if (d < 0) d = 0; else if (d > 2 * pwmMid - 1) d = 2 * pwmMid - 1;
  ledcWrite(TX_PIN, d);
}
uint32_t queued() { return (pqHead - pqTail) & (PQ - 1); }
void enqueue(int16_t v) {
  uint32_t h = pqHead, nh = (h + 1) & (PQ - 1);
  if (nh == pqTail) return;                                // full: drop
  pq[h] = v; pqHead = nh;
}

// ---------- listening: ADC at the PWM rate (D-70), 4 conversions per sample = 15625/s, resampled to 16 kHz ----------
const int GROUP = 4;
adc_continuous_handle_t adc = NULL;
uint8_t dmaBuf[1024];
int groupVals[GROUP]; int groupFill = 0;
float dc = 2048, resPos = 0, resPrev = 0, resStep = 15625.0f / 16000.0f;
const float MIC_GAINS[3] = {16, 32, 64};
int micLevel = 1;                 // x32 default (T-091: x16 gave peaks ~3,000, quiet for the operator)
int16_t frame[FRAME]; int frameFill = 0;
unsigned long lastHeardPlayback = 0;
int micPeak = 0, inPeak = 0;
// noise gate (T-092): frames quieter than ~2.5x the line's own noise floor are sent as silence, so the
// operator can tell when the caller has stopped talking
float noiseFloor = 1000, frameRms = 0; double frameSq = 0; bool gateOn = true; unsigned long gatedFrames = 0, sentFrames = 0;
int MUTE_ABOVE = 3000;            // incoming peak that counts as Doris speaking (T-091: the exchange's quiet background must not mute us)

// ---------- DTMF on the 16 kHz stream ----------
const int N = 410;                              // 25.6 ms
const float ROW_HZ[4] = {697, 770, 852, 941}, COL_HZ[4] = {1209, 1336, 1477, 1633};
const char KEYS[4][4] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}};
float rowCoef[4], colCoef[4];
float blk[N]; int blkFill = 0;
char lastSeen = 0, reported = 0; int sameCount = 0, quietCount = 0;

// ---------- ringing (D-62) ----------
esp_timer_handle_t frTimer;
volatile bool frState = true;
bool ringing = false, burstOn = false;
unsigned long ringStart = 0, phaseStart = 0, windowStart = 0, windowHighMs = 0, lastSample = 0;
const unsigned long RING_ON_MS = 2000, RING_OFF_MS = 4000, RING_MAX_MS = 60000, TRIP_HIGH_MS = 60;
void frToggle(void*) { frState = !frState; digitalWrite(FR_PIN, frState); }
void bellOff() {                       // F/R high > 10 ms before RM goes low (datasheet)
  esp_timer_stop(frTimer);
  digitalWrite(FR_PIN, HIGH); frState = true;
  delay(15);
  digitalWrite(RM_PIN, LOW);
  burstOn = false;
}
void bellOn() {
  digitalWrite(FR_PIN, HIGH); frState = true;
  digitalWrite(RM_PIN, HIGH);
  esp_timer_start_periodic(frTimer, 25000);   // 20 Hz
  burstOn = true;
  phaseStart = windowStart = lastSample = millis(); windowHighMs = 0;
}

// ---------- hook, relay ----------
bool offHook = false, lastRaw = false;
unsigned long rawChangedAt = 0;
WebSocketsClient relay;
bool relayUp = false;

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }
void showState() {
  if (!relayUp) led(30, 20, 0);          // yellow: no relay
  else if (offHook) led(0, 40, 0);       // green: in a call
  else led(0, 0, 10);                    // blue: idle, connected
}

void sendJson(const char* s) { if (relayUp) relay.sendTXT(s); }

float goertzel(const float* x, float coef) {
  float s1 = 0, s2 = 0;
  for (int i = 0; i < N; i++) { float s = x[i] + coef * s1 - s2; s2 = s1; s1 = s; }
  return s1 * s1 + s2 * s2 - coef * s1 * s2;
}

char detectDigit() {
  double mean = 0; for (int i = 0; i < N; i++) mean += blk[i]; mean /= N;
  static float x[N]; double energy = 0;
  for (int i = 0; i < N; i++) { x[i] = blk[i] - mean; energy += x[i] * x[i]; }
  if (sqrt(energy / N) < 300) return 0;          // int16 units after mic gain
  float norm = 2.0f / (N * energy);
  int br = 0, bc = 0; float r[4], c[4];
  for (int i = 0; i < 4; i++) {
    r[i] = goertzel(x, rowCoef[i]) * norm; c[i] = goertzel(x, colCoef[i]) * norm;
    if (r[i] > r[br]) br = i;
    if (c[i] > c[bc]) bc = i;
  }
  if (r[br] < 0.12f || c[bc] < 0.12f || r[br] + c[bc] < 0.55f) return 0;
  for (int i = 0; i < 4; i++) { if (i != br && r[i] * 4 > r[br]) return 0; if (i != bc && c[i] * 4 > c[bc]) return 0; }
  return KEYS[br][bc];
}

void onSample16k(float s) {
  // DTMF
  blk[blkFill++] = s;
  if (blkFill == N) {
    blkFill = 0;
    char d = offHook ? detectDigit() : 0;
    if (d) {
      if (d == lastSeen) sameCount++; else { lastSeen = d; sameCount = 1; }
      quietCount = 0;
      if (sameCount == 2 && d != reported) {
        reported = d;
        char msg[48]; snprintf(msg, sizeof msg, "{\"type\":\"dial\",\"digits\":\"%c\"}", d);
        sendJson(msg);
        Serial.printf("DIGIT %c -> relay\n", d);
      }
    } else { lastSeen = 0; sameCount = 0; if (++quietCount >= 2) reported = 0; }
  }
  // stream to the relay (muted while the relay is talking, plus 250 ms)
  // the relay sends frames even while Doris is silent, so mute only while what's playing is actually sound:
  // from the last loud frame received, until it has played out (queue) plus 300 ms
  bool talking = millis() - lastHeardPlayback < 200 + queued() / 16;
  int v = talking ? 0 : (int)s;
  if (abs(v) > micPeak) micPeak = abs(v);
  if (v > 32767) v = 32767; if (v < -32768) v = -32768;
  frame[frameFill++] = (int16_t)v;
  frameSq += (double)v * v;
  if (frameFill == FRAME) {
    frameFill = 0;
    frameRms = sqrt(frameSq / FRAME); frameSq = 0;
    // track the quietest recent level as the noise floor (falls fast, rises slowly)
    if (!talking) { if (frameRms < noiseFloor) noiseFloor = frameRms; else noiseFloor += (frameRms - noiseFloor) * 0.002f; }
    if (gateOn && frameRms < noiseFloor * 2.5f) { memset(frame, 0, sizeof frame); gatedFrames++; }
    sentFrames++;
    if (relayUp && offHook) relay.sendBIN((uint8_t*)frame, sizeof frame);
  }
}

void onSample15625(int raw) {
  dc += (raw - dc) * 0.0005f;                      // slow DC tracker (the 1.5 V midpoint)
  float x = (raw - dc) * MIC_GAINS[micLevel];
  // linear resample 15625 -> 16000
  while (resPos <= 1.0f) { onSample16k(resPrev + (x - resPrev) * resPos); resPos += resStep; }
  resPos -= 1.0f;
  resPrev = x;
}

void addConversion(int v) {
  groupVals[groupFill++] = v;
  if (groupFill < GROUP) return;
  groupFill = 0;
  long sum = 0; int mn = 4095, mx = 0;
  for (int k = 0; k < GROUP; k++) { int g = groupVals[k]; sum += g; if (g < mn) mn = g; if (g > mx) mx = g; }
  onSample15625((int)((sum - mn - mx) / (GROUP - 2)));
}

void onRelay(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      relayUp = true;
      Serial.println("Relay CONNECTED");
      if (offHook) sendJson("{\"type\":\"offhook\"}");
      showState();
      break;
    case WStype_DISCONNECTED:
      if (relayUp) Serial.println("Relay disconnected (retrying)");
      relayUp = false; showState();
      break;
    case WStype_TEXT: {
      Serial.printf("relay: %.*s\n", (int)len, (const char*)payload);
      char t[64]; size_t n = len < sizeof(t) - 1 ? len : sizeof(t) - 1;
      memcpy(t, payload, n); t[n] = 0;
      if (strstr(t, "\"stop_ring\"")) { if (ringing) { ringing = false; bellOff(); Serial.println("Bell stopped by the relay"); showState(); } }
      else if (strstr(t, "\"ring\"")) {
        if (!offHook && !ringing) { ringing = true; ringStart = millis(); bellOn(); led(40, 0, 0); Serial.println("RINGING"); }
      }
      break;
    }
    case WStype_BIN: {
      if (!offHook || localTone) break;
      const int16_t* s = (const int16_t*)payload;
      float g = EAR_GAINS[earLevel];
      int peak = 0;
      for (size_t i = 0; i < len / 2; i++) { enqueue((int16_t)(s[i] * g)); int a = abs(s[i]); if (a > peak) peak = a; }
      if (peak > inPeak) inPeak = peak;
      if (peak > MUTE_ABOVE) lastHeardPlayback = millis();   // only real speech mutes the microphone
      break;
    }
    default: break;
  }
}

void setup() {
  digitalWrite(RM_PIN, LOW);  pinMode(RM_PIN, OUTPUT);  digitalWrite(RM_PIN, LOW);
  digitalWrite(FR_PIN, HIGH); pinMode(FR_PIN, OUTPUT);  digitalWrite(FR_PIN, HIGH);
  pinMode(SHK_PIN, INPUT);
  for (int i = 0; i < 4; i++) { rowCoef[i] = 2 * cosf(2 * PI * ROW_HZ[i] / RATE); colCoef[i] = 2 * cosf(2 * PI * COL_HZ[i] / RATE); }
  esp_timer_create_args_t ta = {}; ta.callback = &frToggle; ta.name = "fr";
  esp_timer_create(&ta, &frTimer);
  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.println("Project Switchboard - 08-first-call (with ringing)");

  // speaking
  bool ok = ledcAttach(TX_PIN, pwmFreq, pwmBits);
  if (!ok) { pwmBits = 8; pwmFreq = 78125; ok = ledcAttach(TX_PIN, pwmFreq, pwmBits); }
  pwmMid = 1 << (pwmBits - 1);
  pwmIdle = pwmMid / 4;                               // 12.5% resting point (T-090); z toggles 50%
  ledcWrite(TX_PIN, pwmIdle);
  txTimer = timerBegin(1000000);
  timerAttachInterrupt(txTimer, &onTx);
  timerAlarm(txTimer, 1000000 / RATE, true, 0);       // 62.5 us
  Serial.printf("Speaking: PWM %d-bit at %d Hz, 16 kHz updates%s\n", pwmBits, pwmFreq, ok ? "" : " (FAILED)");

  // listening
  resStep = (pwmFreq / (float)GROUP) / RATE;
  adc_continuous_handle_cfg_t hcfg = {}; hcfg.max_store_buf_size = 8192; hcfg.conv_frame_size = sizeof(dmaBuf);
  esp_err_t e = adc_continuous_new_handle(&hcfg, &adc);
  adc_digi_pattern_config_t pat = {}; pat.atten = ADC_ATTEN_DB_12; pat.channel = AUDIO_CH; pat.unit = ADC_UNIT_1; pat.bit_width = SOC_ADC_DIGI_MAX_BITWIDTH;
  adc_continuous_config_t cfg = {}; cfg.sample_freq_hz = pwmFreq; cfg.conv_mode = ADC_CONV_SINGLE_UNIT_1;
  cfg.format = ADC_DIGI_OUTPUT_FORMAT_TYPE2; cfg.pattern_num = 1; cfg.adc_pattern = &pat;
  if (e == ESP_OK) e = adc_continuous_config(adc, &cfg);
  if (e == ESP_OK) e = adc_continuous_start(adc);
  Serial.printf("Listening: ADC at %d Hz, %d per sample, resampled to 16 kHz%s\n", pwmFreq, GROUP, e == ESP_OK ? "" : " (FAILED)");

  // Wi-Fi and relay
  led(0, 0, 30);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Joining Wi-Fi \"%s\"", WIFI_SSID);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " FAILED (will keep trying)");
  if (WiFi.status() == WL_CONNECTED) Serial.printf("IP %s, signal %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());

  String url = String("/phone?token=") + PHONE_TOKEN;
#if RELAY_TLS
  relay.beginSSL(RELAY_HOST, RELAY_PORT, url.c_str());
#else
  relay.begin(RELAY_HOST, RELAY_PORT, url.c_str());
#endif
  relay.onEvent(onRelay);
  relay.setReconnectInterval(3000);
  Serial.printf("Relay: %s://%s:%d/phone\n", RELAY_TLS ? "wss" : "ws", RELAY_HOST, RELAY_PORT);

  offHook = lastRaw = digitalRead(SHK_PIN);
  rawChangedAt = millis();
  showState();
}

void loop() {
  relay.loop();

  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'v' || c == 'V') { earLevel = (earLevel + 1) % 3; Serial.printf("Earpiece: %s\n", EAR_NAMES[earLevel]); }
    else if (c == 'm' || c == 'M') { micLevel = (micLevel + 1) % 3; Serial.printf("Mic gain: x%.0f\n", MIC_GAINS[micLevel]); }
    else if (c == 't' || c == 'T') {
      localTone = !localTone; pqTail = pqHead; primed = false;
      Serial.printf("Earpiece source: %s\n", localTone ? "LOCAL test dial tone (relay audio ignored)" : "relay");
    }
    else if (c == 'g' || c == 'G') { gateOn = !gateOn; Serial.printf("Noise gate %s\n", gateOn ? "ON" : "off"); }
    else if (c == 'z' || c == 'Z') {
      pwmIdle = (pwmIdle == pwmMid) ? pwmMid / 4 : pwmMid;
      Serial.printf("PWM resting point: %s\n", pwmIdle == pwmMid ? "50% (original)" : "12.5% (default: less supply noise, less headroom)");
    }
    else if (c == 'p' || c == 'P') {
      txp = (txp + 1) % 5;
      WiFi.setTxPower(TXP[txp]);
      Serial.printf("Wi-Fi transmit power: %s (signal from the router: %d dBm)\n", TXP_NAMES[txp], WiFi.RSSI());
    }
    else if (c == 'w' || c == 'W') {
      wifiOn = !wifiOn;
      if (wifiOn) { WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.begin(WIFI_SSID, WIFI_PASSWORD); WiFi.setTxPower(TXP[txp]); Serial.println("Wi-Fi radio ON (reconnecting)"); }
      else { relay.disconnect(); WiFi.disconnect(true); WiFi.mode(WIFI_OFF); Serial.println("Wi-Fi radio OFF"); }
    }
    else if (c == '?') Serial.printf("Wi-Fi %s (%d dBm), relay %s, %s, queue %lu\n",
                                     WiFi.status() == WL_CONNECTED ? "up" : "DOWN", WiFi.RSSI(),
                                     relayUp ? "up" : "DOWN", offHook ? "off-hook" : "on-hook", (unsigned long)queued());
  }

  if (localTone && offHook) {             // keep ~200 ms of locally made dial tone queued
    while (queued() < 3200) {
      float v = (sinf(lt350) + sinf(lt440)) * 0.25f * 0.5f * 32767.0f * EAR_GAINS[earLevel];
      lt350 += 2 * PI * 350.0f / RATE; if (lt350 > 2 * PI) lt350 -= 2 * PI;
      lt440 += 2 * PI * 440.0f / RATE; if (lt440 > 2 * PI) lt440 -= 2 * PI;
      enqueue((int16_t)v);
    }
  }
  if (offHook && millis() - lastStats >= 2000) {
    lastStats = millis();
    Serial.printf("  playback: %lu underruns, queue %lu ms, longest tick gap %lu us (should be ~62)%s%s\n",
                  (unsigned long)underruns, (unsigned long)(queued() / 16),
                  (unsigned long)(maxIsrGap / (getCpuFrequencyMhz())),
                  localTone ? "  [local tone]" : "", wifiOn ? "" : "  [Wi-Fi OFF]");
    Serial.printf("  mic: %s, your loudest %d of 32767 in the last 2 s\n",
                  millis() - lastHeardPlayback < 200 + queued() / 16 ? "MUTED (relay playing sound)" : "open", micPeak);
    Serial.printf("  incoming: loudest %d (mutes the mic above %d)\n", inPeak, MUTE_ABOVE);
    Serial.printf("  line noise floor %.0f; noise gate %s, %lu of %lu frames sent as silence\n",
                  noiseFloor, gateOn ? "ON" : "off", gatedFrames, sentFrames);
    gatedFrames = 0; sentFrames = 0;
    micPeak = 0; inPeak = 0;
    underruns = 0; maxIsrGap = 0;
  }

  uint32_t got = 0;
  if (adc_continuous_read(adc, dmaBuf, sizeof(dmaBuf), &got, 2) == ESP_OK) {
    for (uint32_t i = 0; i + SOC_ADC_DIGI_RESULT_BYTES <= got; i += SOC_ADC_DIGI_RESULT_BYTES) {
      adc_digi_output_data_t* p = (adc_digi_output_data_t*)&dmaBuf[i];
      if (p->type2.channel == AUDIO_CH) addConversion(p->type2.data);
    }
  }

  bool raw = digitalRead(SHK_PIN);
  unsigned long now = millis();

  if (ringing) {
    if (burstOn) {
      // ring trip: SHK pulses while ringing; count high time in 200 ms windows
      if (raw) windowHighMs += now - lastSample;
      lastSample = now;
      if (windowHighMs >= TRIP_HIGH_MS) {
        ringing = false; bellOff();
        offHook = true; lastRaw = raw; rawChangedAt = now;
        Serial.println("ANSWERED (lifted while ringing) -> relay");
        sendJson("{\"type\":\"offhook\"}");
        showState();
        return;
      }
      if (now - windowStart >= 200) { windowStart = now; windowHighMs = 0; }
      if (now - phaseStart >= RING_ON_MS) { bellOff(); phaseStart = now; led(8, 0, 0); }
      return;
    }
    if (now - ringStart > RING_MAX_MS) { ringing = false; Serial.println("Ringing gave up (60 s)"); showState(); }
    else if (now - phaseStart >= RING_OFF_MS && !raw) { bellOn(); led(40, 0, 0); }
  }

  if (raw != lastRaw) { lastRaw = raw; rawChangedAt = now; }
  if (raw != offHook && now - rawChangedAt >= (offHook ? 300UL : 30UL)) {
    offHook = raw;
    if (offHook) {
      if (ringing) { ringing = false; Serial.println("ANSWERED between rings"); }
      Serial.println("OFF-HOOK -> relay"); sendJson("{\"type\":\"offhook\"}");
    }
    else {
      Serial.println("ON-HOOK -> relay"); sendJson("{\"type\":\"onhook\"}");
      pqTail = pqHead; primed = false;                    // drop anything still queued
    }
    reported = 0; showState();
  }
}
