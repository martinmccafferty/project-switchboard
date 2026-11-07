// Project Switchboard - Phase 2, step 2: blink the onboard RGB LED.
// Board: ESP32S3 Dev Module (Arduino-ESP32 core 3.x).
// Proves the cable, port, upload and board all work.

const int LED_PIN = 48;   // onboard RGB LED on most ESP32-S3 DevKitC-1 boards (some use 38)

void setup() {
}

void loop() {
  rgbLedWrite(LED_PIN, 40, 0, 0);   // red   (values 0-255; kept low because it's bright)
  delay(500);
  rgbLedWrite(LED_PIN, 0, 40, 0);   // green
  delay(500);
  rgbLedWrite(LED_PIN, 0, 0, 40);   // blue
  delay(500);
  rgbLedWrite(LED_PIN, 0, 0, 0);    // off
  delay(500);
}
