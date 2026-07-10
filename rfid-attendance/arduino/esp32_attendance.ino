/*
 * ============================================================
 * RFID Employee Attendance System - ESP32 Firmware
 * ============================================================
 *
 * Hardware: ESP32 DevKit V1 + RC522 RFID Reader
 *
 * Wiring Diagram:
 * RC522 Pin  ->  ESP32 Pin
 * SDA        ->  GPIO 5
 * SCK        ->  GPIO 18
 * MOSI       ->  GPIO 23
 * MISO       ->  GPIO 19
 * RST        ->  GPIO 22
 * 3.3V       ->  3.3V
 * GND        ->  GND
 *
 * LED Indicators:
 * Green LED  ->  GPIO 2  (Built-in LED on most ESP32 boards)
 * Red LED    ->  GPIO 4  (External LED for failure indication)
 *
 * Libraries Required:
 * 1. MFRC522 by GithubCommunity (Install via Library Manager)
 * 2. ArduinoJson by Benoit Blanchon (Install via Library Manager)
 * 3. WiFi (Built-in with ESP32 board package)
 * 4. HTTPClient (Built-in with ESP32 board package)
 *
 * Setup Instructions:
 * 1. Install ESP32 board package in Arduino IDE
 *    - Go to File > Preferences
 *    - Add this URL to Additional Board Manager URLs:
 *      https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
 *    - Go to Tools > Board > Board Manager
 *    - Search "ESP32" and install "ESP32 by Espressif Systems"
 * 2. Install MFRC522 library
 *    - Go to Sketch > Include Library > Manage Libraries
 *    - Search "MFRC522" and install
 * 3. Install ArduinoJson library
 *    - Search "ArduinoJson" and install version 6.x
 * 4. Select Board: "ESP32 Dev Module"
 * 5. Select correct COM port
 * 6. Upload this sketch
 *
 * ============================================================
 */

#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ============================================================
// CONFIGURATION - CHANGE THESE VALUES
// ============================================================

// WiFi Credentials - Replace with your WiFi details
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Google Apps Script Web App URL - Replace with your deployed URL
const char* SERVER_URL = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec";

// Device identification
const char* DEVICE_NAME = "Main_Entrance";

// ============================================================
// PIN DEFINITIONS
// ============================================================

#define SS_PIN    5    // SDA pin of RC522
#define RST_PIN   22   // RST pin of RC522
#define LED_GREEN 2    // Built-in LED (success indicator)
#define LED_RED   4    // External LED (failure indicator)
#define BUZZER    15   // Optional buzzer pin

// ============================================================
// GLOBAL VARIABLES
// ============================================================

// RFID reader instance
MFRC522 rfid(SS_PIN, RST_PIN);

// Store the last scanned UID and timestamp to prevent duplicate scans
String lastScannedUID = "";
unsigned long lastScanTime = 0;

// Minimum time between same card scans (10 seconds)
const unsigned long SCAN_COOLDOWN = 10000;

// WiFi reconnection interval
unsigned long lastWiFiCheck = 0;
const unsigned long WIFI_CHECK_INTERVAL = 30000; // Check every 30 seconds

// ============================================================
// SETUP FUNCTION - Runs once when ESP32 starts
// ============================================================

void setup() {
  // Initialize Serial Monitor for debugging
  Serial.begin(115200);
  Serial.println();
  Serial.println("============================================================");
  Serial.println("   RFID Employee Attendance System - Starting Up");
  Serial.println("============================================================");
  Serial.println();

  // Configure LED pins as outputs
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_RED, OUTPUT);
  pinMode(BUZZER, OUTPUT);

  // Turn off all LEDs initially
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_RED, LOW);
  digitalWrite(BUZZER, LOW);

  // Initialize SPI bus for RFID communication
  SPI.begin();
  Serial.println("[OK] SPI bus initialized");

  // Initialize RFID reader
  rfid.PCD_Init();
  Serial.println("[OK] RFID reader initialized");

  // Print RFID reader firmware version (for debugging)
  Serial.print("[INFO] MFRC522 Firmware Version: ");
  rfid.PCD_DumpVersionToSerial();

  // Connect to WiFi
  connectWiFi();

  // Startup complete indication
  blinkLED(LED_GREEN, 3, 200);
  Serial.println();
  Serial.println("============================================================");
  Serial.println("   System Ready - Please scan your RFID card");
  Serial.println("============================================================");
  Serial.println();
}

// ============================================================
// MAIN LOOP - Runs continuously
// ============================================================

void loop() {
  // Check WiFi connection periodically
  if (millis() - lastWiFiCheck > WIFI_CHECK_INTERVAL) {
    lastWiFiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WARNING] WiFi disconnected. Reconnecting...");
      connectWiFi();
    }
  }

  // Check if a new RFID card is present
  if (!rfid.PICC_IsNewCardPresent()) {
    return; // No card detected, exit loop iteration
  }

  // Try to read the card's UID
  if (!rfid.PICC_ReadCardSerial()) {
    return; // Could not read card, exit loop iteration
  }

  // Get the UID as a string
  String uid = getUID();

  // Print the scanned UID to Serial Monitor
  Serial.println();
  Serial.println("------------------------------------------------------------");
  Serial.print("[SCAN] Card detected! UID: ");
  Serial.println(uid);

  // Check for duplicate scan (same card within cooldown period)
  if (uid == lastScannedUID && (millis() - lastScanTime) < SCAN_COOLDOWN) {
    Serial.println("[INFO] Duplicate scan ignored (cooldown active)");
    Serial.print("[INFO] Please wait ");
    Serial.print((SCAN_COOLDOWN - (millis() - lastScanTime)) / 1000);
    Serial.println(" seconds before scanning again");
    blinkLED(LED_RED, 2, 100);
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }

  // Update last scan info
  lastScannedUID = uid;
  lastScanTime = millis();

  // Send attendance data to server
  if (WiFi.status() == WL_CONNECTED) {
    sendAttendance(uid);
  } else {
    Serial.println("[ERROR] WiFi not connected! Cannot send data.");
    blinkLED(LED_RED, 5, 100);
    // Try to reconnect
    connectWiFi();
  }

  Serial.println("------------------------------------------------------------");

  // Halt the card to stop reading
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

// ============================================================
// FUNCTION: Connect to WiFi network
// ============================================================

void connectWiFi() {
  Serial.print("[WiFi] Connecting to: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA); // Set WiFi to station mode
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Wait for connection (timeout after 20 seconds)
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
    // Blink red LED while connecting
    digitalWrite(LED_RED, !digitalRead(LED_RED));
  }

  Serial.println();
  digitalWrite(LED_RED, LOW);

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("[WiFi] Connected successfully!");
    Serial.print("[WiFi] IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.print("[WiFi] Signal Strength (RSSI): ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
    blinkLED(LED_GREEN, 2, 300);
  } else {
    Serial.println("[WiFi] Connection FAILED!");
    Serial.println("[WiFi] Please check SSID and password");
    blinkLED(LED_RED, 5, 200);
  }
}

// ============================================================
// FUNCTION: Get RFID UID as a formatted string
// ============================================================

String getUID() {
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    // Add leading zero for single digit hex values
    if (rfid.uid.uidByte[i] < 0x10) {
      uid += "0";
    }
    uid += String(rfid.uid.uidByte[i], HEX);
    // Add space separator between bytes (except last)
    if (i < rfid.uid.size - 1) {
      uid += " ";
    }
  }
  uid.toUpperCase(); // Convert to uppercase for consistency
  return uid;
}

// ============================================================
// FUNCTION: Send attendance data to Google Apps Script
// ============================================================

void sendAttendance(String uid) {
  Serial.println("[HTTP] Sending attendance data to server...");

  HTTPClient http;

  // Begin HTTP connection
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");

  // Set timeouts
  http.setTimeout(10000); // 10 second timeout

  // Create JSON payload
  StaticJsonDocument<256> jsonDoc;
  jsonDoc["rfid_uid"] = uid;
  jsonDoc["device"] = DEVICE_NAME;
  jsonDoc["ip"] = WiFi.localIP().toString();
  jsonDoc["action"] = "scan";

  // Serialize JSON to string
  String jsonPayload;
  serializeJson(jsonDoc, jsonPayload);

  Serial.print("[HTTP] Payload: ");
  Serial.println(jsonPayload);

  // Send POST request
  int httpResponseCode = http.POST(jsonPayload);

  // Handle response
  if (httpResponseCode > 0) {
    String response = http.getString();
    Serial.print("[HTTP] Response Code: ");
    Serial.println(httpResponseCode);
    Serial.print("[HTTP] Response: ");
    Serial.println(response);

    // Parse server response
    StaticJsonDocument<512> responseDoc;
    DeserializationError error = deserializeJson(responseDoc, response);

    if (!error) {
      const char* status = responseDoc["status"];
      const char* message = responseDoc["message"];

      if (String(status) == "success") {
        Serial.print("[SUCCESS] ");
        Serial.println(message);
        // Green LED and buzzer for success
        successIndication();
      } else {
        Serial.print("[FAILED] ");
        Serial.println(message);
        // Red LED for failure
        failureIndication();
      }
    } else {
      Serial.println("[HTTP] JSON parse error in response");
      successIndication(); // Assume success if we got HTTP 200
    }
  } else {
    Serial.print("[HTTP] Error Code: ");
    Serial.println(httpResponseCode);
    Serial.println("[HTTP] Failed to send data!");
    failureIndication();
  }

  // Close HTTP connection
  http.end();
}

// ============================================================
// FUNCTION: Success indication (LED + Buzzer)
// ============================================================

void successIndication() {
  // Single long green blink + short beep
  digitalWrite(LED_GREEN, HIGH);
  digitalWrite(BUZZER, HIGH);
  delay(200);
  digitalWrite(BUZZER, LOW);
  delay(800);
  digitalWrite(LED_GREEN, LOW);
}

// ============================================================
// FUNCTION: Failure indication (LED + Buzzer)
// ============================================================

void failureIndication() {
  // Three rapid red blinks + three short beeps
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_RED, HIGH);
    digitalWrite(BUZZER, HIGH);
    delay(100);
    digitalWrite(LED_RED, LOW);
    digitalWrite(BUZZER, LOW);
    delay(100);
  }
}

// ============================================================
// FUNCTION: Blink LED helper
// ============================================================

void blinkLED(int pin, int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(pin, HIGH);
    delay(delayMs);
    digitalWrite(pin, LOW);
    delay(delayMs);
  }
}
