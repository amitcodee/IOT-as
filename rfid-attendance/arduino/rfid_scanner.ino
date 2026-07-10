/*
  ESP32 + RC522 RFID Scanner
  Reads card UID and sends it over USB Serial to Python.

  WIRING:
    RC522   ->  ESP32
    SDA     ->  GPIO 5
    SCK     ->  GPIO 18
    MOSI    ->  GPIO 23
    MISO    ->  GPIO 19
    RST     ->  GPIO 22
    3.3V    ->  3.3V
    GND     ->  GND
*/

#include <SPI.h>
#include <MFRC522.h>

#define SS_PIN  5
#define RST_PIN 22

MFRC522 rfid(SS_PIN, RST_PIN);

String lastUID = "";
unsigned long lastScanTime = 0;

void setup() {
  Serial.begin(115200);
  SPI.begin();
  rfid.PCD_Init();
  pinMode(2, OUTPUT); // built-in LED
  Serial.println("RFID_READY");
}

void loop() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    return;
  }

  // Build UID string
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();

  // Skip duplicate scan within 3 seconds
  if (uid == lastUID && (millis() - lastScanTime) < 3000) {
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }

  lastUID = uid;
  lastScanTime = millis();

  // Send UID to Python over serial
  Serial.println("UID:" + uid);

  // Blink LED
  digitalWrite(2, HIGH);
  delay(200);
  digitalWrite(2, LOW);

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}
