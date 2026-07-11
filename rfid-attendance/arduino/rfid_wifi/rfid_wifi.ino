/*
  TechCADD Attendance - ESP32 WiFi + Firebase (REST API)
  ESP32 reads RFID card → connects to WiFi → writes to Firestore via REST
  No extra Firebase library needed. Uses built-in HTTPClient.

  WIRING:
    RC522   ->  ESP32
    SDA     ->  GPIO 5
    SCK     ->  GPIO 18
    MOSI    ->  GPIO 23
    MISO    ->  GPIO 19
    RST     ->  GPIO 22
    3.3V    ->  3.3V
    GND     ->  GND

  LIBRARIES NEEDED (install via Arduino Library Manager):
    - MFRC522
    - ArduinoJson
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ArduinoJson.h>
#include <time.h>

// ============================================================
//  CHANGE THESE VALUES TO YOUR OWN
// ============================================================
#define WIFI_SSID       "YOUR_OFFICE_WIFI_NAME"
#define WIFI_PASSWORD   "YOUR_WIFI_PASSWORD"

#define FIREBASE_API_KEY      "YOUR_FIREBASE_API_KEY"
#define FIREBASE_PROJECT_ID   "YOUR_FIREBASE_PROJECT_ID"
#define FIREBASE_EMAIL        "YOUR_FIREBASE_AUTH_EMAIL"
#define FIREBASE_PASSWORD     "YOUR_FIREBASE_AUTH_PASSWORD"
// ============================================================

// NTP for accurate time (India = +5:30 = 19800 sec)
#define NTP_SERVER   "pool.ntp.org"
#define GMT_OFFSET   19800
#define DST_OFFSET   0

#define SS_PIN  5
#define RST_PIN 22
#define LED_PIN 2

MFRC522 rfid(SS_PIN, RST_PIN);

String lastUID = "";
unsigned long lastScanTime = 0;
String idToken = "";
unsigned long tokenTime = 0;

void blinkLed(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH); delay(ms);
    digitalWrite(LED_PIN, LOW);  delay(ms);
  }
}

String getDateKey() {
  struct tm t;
  if (!getLocalTime(&t)) return "";
  char buf[11];
  strftime(buf, sizeof(buf), "%Y-%m-%d", &t);
  return String(buf);
}

String getTimeStr() {
  struct tm t;
  if (!getLocalTime(&t)) return "";
  char buf[9];
  strftime(buf, sizeof(buf), "%H:%M:%S", &t);
  return String(buf);
}

// ---- WiFi ----
void connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  }
  Serial.println();
  Serial.println("WiFi connected: " + WiFi.localIP().toString());
  digitalWrite(LED_PIN, HIGH);
}

// ---- Firebase Auth (REST API) ----
bool firebaseLogin() {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;

  String url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + String(FIREBASE_API_KEY);
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");

  String body = "{\"email\":\"" + String(FIREBASE_EMAIL) +
                "\",\"password\":\"" + String(FIREBASE_PASSWORD) +
                "\",\"returnSecureToken\":true}";

  int code = http.POST(body);
  if (code == 200) {
    JsonDocument doc;
    deserializeJson(doc, http.getString());
    idToken = doc["idToken"].as<String>();
    tokenTime = millis();
    Serial.println("Firebase login OK");
    http.end();
    return true;
  } else {
    Serial.println("Firebase login failed: " + String(code));
    Serial.println(http.getString());
    http.end();
    return false;
  }
}

void refreshTokenIfNeeded() {
  // Token expires in ~1 hour, refresh every 50 min
  if (idToken == "" || (millis() - tokenTime) > 3000000) {
    Serial.println("Refreshing token...");
    firebaseLogin();
  }
}

// ---- Firestore REST API ----
String firestoreUrl(String path) {
  return "https://firestore.googleapis.com/v1/projects/" + String(FIREBASE_PROJECT_ID) +
         "/databases/(default)/documents/" + path;
}

// GET a document
String firestoreGet(String path) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, firestoreUrl(path));
  http.addHeader("Authorization", "Bearer " + idToken);
  int code = http.GET();
  String response = "";
  if (code == 200) {
    response = http.getString();
  }
  http.end();
  return response;
}

// CREATE or SET a document
bool firestoreSet(String path, String jsonBody) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, firestoreUrl(path));
  http.addHeader("Authorization", "Bearer " + idToken);
  http.addHeader("Content-Type", "application/json");
  int code = http.PATCH(jsonBody);
  bool ok = (code == 200);
  if (!ok) {
    Serial.println("Firestore write error " + String(code) + ": " + http.getString());
  }
  http.end();
  return ok;
}

// PATCH (update) a document
bool firestoreUpdate(String path, String jsonBody, String updateMask) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = firestoreUrl(path) + "?updateMask.fieldPaths=" + updateMask;
  http.begin(client, url);
  http.addHeader("Authorization", "Bearer " + idToken);
  http.addHeader("Content-Type", "application/json");
  int code = http.PATCH(jsonBody);
  bool ok = (code == 200);
  if (!ok) {
    Serial.println("Firestore update error " + String(code));
  }
  http.end();
  return ok;
}

// ---- Process Scan ----
void processScan(String uid) {
  refreshTokenIfNeeded();
  if (idToken == "") {
    Serial.println("No token, skipping scan");
    blinkLed(5, 80);
    return;
  }

  String dateKey = getDateKey();
  String timeStr = getTimeStr();
  if (dateKey == "" || timeStr == "") {
    Serial.println("Time not ready, skipping");
    blinkLed(5, 80);
    return;
  }

  // 1. Check if employee exists
  String empResp = firestoreGet("employees/" + uid);
  if (empResp == "") {
    Serial.println("UNKNOWN CARD: " + uid);
    blinkLed(5, 80);
    return;
  }

  // Parse employee name and ID
  JsonDocument empDoc;
  deserializeJson(empDoc, empResp);
  String empName = empDoc["fields"]["name"]["stringValue"] | "Unknown";
  String empId = empDoc["fields"]["employeeId"]["stringValue"] | "";

  // 2. Check if attendance record exists for today
  String docId = dateKey + "_" + uid;
  String attResp = firestoreGet("attendance/" + docId);

  if (attResp == "") {
    // No record → CHECK IN
    String body = "{\"fields\":{"
      "\"uid\":{\"stringValue\":\"" + uid + "\"},"
      "\"employeeId\":{\"stringValue\":\"" + empId + "\"},"
      "\"employeeName\":{\"stringValue\":\"" + empName + "\"},"
      "\"dateKey\":{\"stringValue\":\"" + dateKey + "\"},"
      "\"checkIn\":{\"stringValue\":\"" + timeStr + "\"},"
      "\"checkOut\":{\"nullValue\":null}"
    "}}";

    if (firestoreSet("attendance/" + docId, body)) {
      Serial.println("CHECK IN: " + empName + " at " + timeStr);
      blinkLed(1, 200);
    } else {
      blinkLed(5, 80);
    }
    return;
  }

  // Record exists — check if checkOut is null
  JsonDocument attDoc;
  deserializeJson(attDoc, attResp);
  bool hasCheckOut = attDoc["fields"]["checkOut"].containsKey("stringValue");

  if (!hasCheckOut) {
    // CHECK OUT
    String body = "{\"fields\":{"
      "\"checkOut\":{\"stringValue\":\"" + timeStr + "\"}"
    "}}";

    if (firestoreUpdate("attendance/" + docId, body, "checkOut")) {
      Serial.println("CHECK OUT: " + empName + " at " + timeStr);
      blinkLed(2, 150);
    } else {
      blinkLed(5, 80);
    }
    return;
  }

  // Already done
  Serial.println("ALREADY DONE: " + empName);
  blinkLed(3, 300);
}

// ---- Setup ----
void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println();
  Serial.println("================================");
  Serial.println("  TechCADD Attendance System");
  Serial.println("  ESP32 + RC522 + WiFi");
  Serial.println("================================");

  connectWiFi();

  // Sync time
  configTime(GMT_OFFSET, DST_OFFSET, NTP_SERVER);
  Serial.print("Syncing time");
  struct tm t;
  int tries = 0;
  while (!getLocalTime(&t) && tries < 20) { delay(500); Serial.print("."); tries++; }
  Serial.println();
  if (tries < 20) Serial.println("Time: " + getDateKey() + " " + getTimeStr());
  else Serial.println("Time sync failed");

  // Firebase login
  firebaseLogin();

  // RFID
  SPI.begin();
  rfid.PCD_Init();

  Serial.println();
  Serial.println("SYSTEM READY - Scan a card!");
  Serial.println("================================");
  blinkLed(3, 150);
  digitalWrite(LED_PIN, HIGH);
}

// ---- Loop ----
void loop() {
  // Auto reconnect WiFi
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost, reconnecting...");
    digitalWrite(LED_PIN, LOW);
    connectWiFi();
    digitalWrite(LED_PIN, HIGH);
  }

  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    return;
  }

  // Build UID
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();

  // Skip duplicate within 3 sec
  if (uid == lastUID && (millis() - lastScanTime) < 3000) {
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }

  lastUID = uid;
  lastScanTime = millis();
  Serial.println("Card: " + uid);

  processScan(uid);

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}
