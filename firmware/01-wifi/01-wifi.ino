// Project Switchboard - Phase 2, step 3: join home Wi-Fi and report signal strength.
// Board: ESP32S3 Dev Module (Arduino-ESP32 core 3.x).
// Tools -> USB CDC On Boot: Enabled  (so Serial Monitor works over the native USB port)
//
// Wi-Fi name and password live in secrets.h (never committed to git).
// Copy secrets.h.example to secrets.h and fill it in.

#include <WiFi.h>
#include "secrets.h"

const int LED_PIN = 48;          // onboard RGB LED (confirmed C-26)

void led(int r, int g, int b) { rgbLedWrite(LED_PIN, r, g, b); }

const char* signalQuality(int rssi) {
  if (rssi >= -55) return "excellent";
  if (rssi >= -67) return "good";
  if (rssi >= -75) return "fair (may be unreliable for audio)";
  return "poor (too weak for audio)";
}

void connectWiFi() {
  Serial.printf("Connecting to \"%s\"", WIFI_SSID);
  led(0, 0, 40);                               // blue = connecting
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    led(0, 40, 0);                             // green = connected
    Serial.println("CONNECTED");
    Serial.print("  IP address:  "); Serial.println(WiFi.localIP());
    Serial.print("  MAC address: "); Serial.println(WiFi.macAddress());
    Serial.printf("  Channel:     %d\n", WiFi.channel());
  } else {
    led(40, 0, 0);                             // red = failed
    Serial.printf("FAILED (status code %d). Check the name and password in secrets.h.\n", WiFi.status());
  }
}

void setup() {
  Serial.begin(115200);
  unsigned long t = millis();
  while (!Serial && millis() - t < 3000) delay(10);   // give the Mac a moment to open the port
  Serial.println();
  Serial.println("=== Project Switchboard: Wi-Fi test ===");
  connectWiFi();
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    int rssi = WiFi.RSSI();
    Serial.printf("Signal: %d dBm (%s)\n", rssi, signalQuality(rssi));
  } else {
    Serial.println("Wi-Fi lost - reconnecting...");
    connectWiFi();
  }
  delay(5000);
}
