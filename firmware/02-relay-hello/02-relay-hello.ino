// Project Switchboard - Phase 2, step 5: talk to the relay over a WebSocket.
// Board: ESP32S3 Dev Module; Tools -> USB CDC On Boot: Enabled.
// Library: "WebSockets" by Markus Sattler (Arduino Library Manager).
// LED: blue = joining Wi-Fi, yellow = looking for relay, green = relay connected, red = Wi-Fi failed.

#include <WiFi.h>
#include <WebSocketsClient.h>
#include "secrets.h"     // WIFI_SSID, WIFI_PASSWORD, RELAY_HOST, RELAY_PORT

const int LED_PIN = 48;
WebSocketsClient relay;
unsigned long lastSend = 0;
int counter = 0;

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }

void onRelayEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      led(0, 40, 0);
      Serial.println("Relay CONNECTED");
      relay.sendTXT("Hello from the phone!");
      break;
    case WStype_TEXT:
      Serial.printf("Relay says: %.*s\n", (int)length, (const char*)payload);
      break;
    case WStype_DISCONNECTED:
      led(40, 30, 0);
      Serial.println("Relay disconnected - will retry every 3 s");
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  unsigned long t = millis();
  while (!Serial && millis() - t < 3000) delay(10);
  Serial.println("\n=== Project Switchboard: relay hello ===");

  led(0, 0, 40);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Joining Wi-Fi");
  while (WiFi.status() != WL_CONNECTED && millis() - t < 20000) { delay(500); Serial.print("."); }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) { led(40, 0, 0); Serial.println("Wi-Fi FAILED"); return; }
  Serial.print("Wi-Fi OK, my IP: "); Serial.println(WiFi.localIP());

  led(40, 30, 0);
  Serial.printf("Connecting to relay at %s:%d ...\n", RELAY_HOST, RELAY_PORT);
  relay.begin(RELAY_HOST, RELAY_PORT, "/");
  relay.onEvent(onRelayEvent);
  relay.setReconnectInterval(3000);
}

void loop() {
  relay.loop();
  if (relay.isConnected() && millis() - lastSend > 10000) {
    lastSend = millis();
    String msg = "Still here #" + String(++counter);
    relay.sendTXT(msg);
    Serial.println("Sent: " + msg);
  }
}
