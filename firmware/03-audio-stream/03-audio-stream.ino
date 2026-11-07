// Project Switchboard - Phase 2, test B (T-006): stream phone-quality audio to the relay.
// Sends a 440 Hz test tone as 16 kHz, 16-bit mono audio (256 kbit/s) in 20 ms frames for 60 s.
// The relay echoes every frame back, so both directions are tested.
// Board: ESP32S3 Dev Module; USB CDC On Boot: Enabled. Library: "WebSockets" by Markus Sattler.
// LED: blue = Wi-Fi, yellow = finding relay, purple = streaming, green = finished.

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <math.h>
#include "secrets.h"     // WIFI_SSID, WIFI_PASSWORD, RELAY_HOST, RELAY_PORT

const int LED_PIN = 48;
const int SAMPLE_RATE = 16000;
const int FRAME_MS = 20;
const int FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000;   // 320 samples = 640 bytes
const unsigned long TEST_MS = 60000;
const float TONE_HZ = 440.0;

WebSocketsClient relay;
int16_t frame[FRAME_SAMPLES];
float phase = 0;
bool streaming = false, finished = false, summaryDone = false;
unsigned long startMs = 0, finishedMs = 0, lastReport = 0;
unsigned long framesSent = 0, echoBytes = 0;

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }

void fillFrame() {
  const float step = 2.0f * PI * TONE_HZ / SAMPLE_RATE;
  for (int i = 0; i < FRAME_SAMPLES; i++) {
    frame[i] = (int16_t)(sinf(phase) * 8000);
    phase += step;
    if (phase > 2.0f * PI) phase -= 2.0f * PI;
  }
}

void onRelayEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("Relay CONNECTED");
      if (!finished) {
        relay.sendTXT("START");
        streaming = true;
        startMs = millis();
        lastReport = startMs;
        framesSent = 0;
        echoBytes = 0;
        led(30, 0, 30);
        Serial.println("Streaming test tone for 60 s...");
      }
      break;
    case WStype_TEXT:
      Serial.printf("Relay says: %.*s\n", (int)length, (const char*)payload);
      break;
    case WStype_BIN:
      echoBytes += length;
      break;
    case WStype_DISCONNECTED:
      if (streaming) Serial.println("Relay disconnected DURING the test");
      streaming = false;
      if (!finished) led(40, 30, 0);
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  unsigned long t = millis();
  while (!Serial && millis() - t < 3000) delay(10);
  Serial.println("\n=== Project Switchboard: audio streaming test ===");

  led(0, 0, 40);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                       // keep the radio fully awake for steady audio
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Joining Wi-Fi");
  while (WiFi.status() != WL_CONNECTED && millis() - t < 20000) { delay(500); Serial.print("."); }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) { led(40, 0, 0); Serial.println("Wi-Fi FAILED"); return; }
  Serial.printf("Wi-Fi OK, signal %d dBm\n", WiFi.RSSI());

  led(40, 30, 0);
  relay.begin(RELAY_HOST, RELAY_PORT, "/");
  relay.onEvent(onRelayEvent);
  relay.setReconnectInterval(3000);
}

void loop() {
  relay.loop();

  if (streaming) {
    unsigned long elapsed = millis() - startMs;
    while (streaming && framesSent < elapsed / FRAME_MS + 1 && elapsed < TEST_MS) {
      fillFrame();
      relay.sendBIN((uint8_t*)frame, sizeof(frame));
      framesSent++;
    }
    if (millis() - lastReport >= 5000) {
      lastReport = millis();
      Serial.printf("t=%2lus  sent %lu frames (%lu KB), echoed back %lu KB\n",
                    elapsed / 1000, framesSent, framesSent * sizeof(frame) / 1024, echoBytes / 1024);
    }
    if (elapsed >= TEST_MS) {
      streaming = false;
      finished = true;
      finishedMs = millis();
      relay.sendTXT("END");
    }
  }

  if (finished && !summaryDone && millis() - finishedMs > 2000) {   // let the last echoes arrive
    summaryDone = true;
    led(0, 40, 0);
    unsigned long sentBytes = framesSent * sizeof(frame);
    Serial.println("=== Test finished ===");
    Serial.printf("  Sent:        %lu frames, %lu bytes\n", framesSent, sentBytes);
    Serial.printf("  Echoed back: %lu bytes (%.1f%%)\n", echoBytes, 100.0 * echoBytes / sentBytes);
    Serial.println("  Press RST to run the test again.");
  }
}
