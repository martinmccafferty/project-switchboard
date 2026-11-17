// Project Switchboard - 08-first-call (T-084): the real phone talks to the exchange.
// Lift the handset: the relay's dial tone plays in the earpiece. Dial 0: Doris answers. Talk to her.
// Protocol (relay/switchboard.mjs): binary 16 kHz 16-bit mono PCM, 20 ms frames, both ways;
// text {"type":"offhook"|"onhook"} and {"type":"dial","digits":"0"} to the relay; {"type":"status",...} back.
// Half duplex for now: while the relay is talking, the microphone is muted (the AG1171 echoes some of what we
// play back into what we hear, Q-24, and the operator would otherwise hear herself). Ringing is not handled yet.
// Board: ESP32S3 Dev Module; USB CDC On Boot: Enabled; 115200 baud. Library: "WebSockets" by Markus Sattler.
// Wiring as 99-regression. Commands: v earpiece volume, m microphone gain, ? status.
// Interference diagnosis (T-085): t = local test tone instead of the relay's audio (same level, Wi-Fi still on);
// w = Wi-Fi radio off/on (use with t). While off-hook, every 2 s: playback underruns and queue depth.

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <math.h>
#include "esp_adc/adc_continuous.h"
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
volatile uint32_t underruns = 0;
bool localTone = false, wifiOn = true;
float lt350 = 0, lt440 = 0;
unsigned long lastStats = 0;
hw_timer_t* txTimer = NULL;
const float EAR_GAINS[3] = {0.12f, 0.25f, 0.5f};
const char* EAR_NAMES[3] = {"quiet", "medium", "loud"};
int earLevel = 1;

void onTx() {
  uint32_t h = pqHead, t = pqTail;
  uint32_t n = (h - t) & (PQ - 1);
  int16_t v = 0;
  if (!primed) { if (n >= 1600) primed = true; }          // wait for 100 ms of audio before starting
  if (primed) {
    if (n == 0) { primed = false; underruns++; }           // ran dry: rebuffer (a gap = a click)
    else { v = pq[t]; pqTail = (t + 1) & (PQ - 1); }
  }
  ledcWrite(TX_PIN, pwmMid + (((int32_t)v * (pwmMid - 1)) >> 15));
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
const float MIC_GAINS[3] = {8, 16, 32};
int micLevel = 1;
int16_t frame[FRAME]; int frameFill = 0;
unsigned long lastHeardPlayback = 0;

// ---------- DTMF on the 16 kHz stream ----------
const int N = 410;                              // 25.6 ms
const float ROW_HZ[4] = {697, 770, 852, 941}, COL_HZ[4] = {1209, 1336, 1477, 1633};
const char KEYS[4][4] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}};
float rowCoef[4], colCoef[4];
float blk[N]; int blkFill = 0;
char lastSeen = 0, reported = 0; int sameCount = 0, quietCount = 0;

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
  bool talking = queued() > 0 || millis() - lastHeardPlayback < 250;
  int v = talking ? 0 : (int)s;
  if (v > 32767) v = 32767; if (v < -32768) v = -32768;
  frame[frameFill++] = (int16_t)v;
  if (frameFill == FRAME) {
    frameFill = 0;
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
    case WStype_TEXT:
      Serial.printf("relay: %.*s\n", (int)len, (const char*)payload);
      break;
    case WStype_BIN: {
      if (!offHook || localTone) break;
      const int16_t* s = (const int16_t*)payload;
      float g = EAR_GAINS[earLevel];
      for (size_t i = 0; i < len / 2; i++) enqueue((int16_t)(s[i] * g));
      lastHeardPlayback = millis();
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
  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.println("Project Switchboard - 08-first-call");

  // speaking
  bool ok = ledcAttach(TX_PIN, pwmFreq, pwmBits);
  if (!ok) { pwmBits = 8; pwmFreq = 78125; ok = ledcAttach(TX_PIN, pwmFreq, pwmBits); }
  pwmMid = 1 << (pwmBits - 1);
  ledcWrite(TX_PIN, pwmMid);
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
    else if (c == 'w' || c == 'W') {
      wifiOn = !wifiOn;
      if (wifiOn) { WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.begin(WIFI_SSID, WIFI_PASSWORD); Serial.println("Wi-Fi radio ON (reconnecting)"); }
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
    Serial.printf("  playback: %lu underruns, queue %lu samples (%lu ms)%s\n", (unsigned long)underruns,
                  (unsigned long)queued(), (unsigned long)(queued() / 16), localTone ? "  [local tone]" : "");
    underruns = 0;
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
  if (raw != lastRaw) { lastRaw = raw; rawChangedAt = now; }
  if (raw != offHook && now - rawChangedAt >= (offHook ? 300UL : 30UL)) {
    offHook = raw;
    if (offHook) { Serial.println("OFF-HOOK -> relay"); sendJson("{\"type\":\"offhook\"}"); }
    else {
      Serial.println("ON-HOOK -> relay"); sendJson("{\"type\":\"onhook\"}");
      pqTail = pqHead; primed = false;                    // drop anything still queued
    }
    reported = 0; showState();
  }
}
