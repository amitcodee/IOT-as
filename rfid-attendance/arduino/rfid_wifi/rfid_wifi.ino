/*
  TechCADD Attendance - ESP32 WiFi + Firebase
  ESP32 reads RFID card → connects to WiFi → writes to Firestore
  No laptop needed. Just power adapter + WiFi.

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
    - Firebase ESP Client (by Mobizt)
*/

#include <WiFi.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <time.h>

// ============================================================
//  CHANGE THESE 4 SETTINGS TO YOUR VALUES
// ============================================================
#define WIFI_SSID       "YOUR_OFFICE_WIFI_NAME"
#define WIFI_PASSWORD   "YOUR_WIFI_PASSWORD"

#define FIREBASE_API_KEY      "YOUR_FIREBASE_API_KEY"
#define FIREBASE_PROJECT_ID   "YOUR_FIREBASE_PROJECT_ID"
#define FIREBASE_EMAIL        "YOUR_FIREBASE_AUTH_EMAIL"
#define FIREBASE_PASSWORD     "YOUR_FIREBASE_AUTH_PASSWORD"
// ============================================================

// NTP for accurate time
#define NTP_SERVER   "pool.ntp.org"
#define GMT_OFFSET   19800   // India = +5:30 = 19800 seconds. Change for your timezone.
#define DST_OFFSET   0

#define SS_PIN  5
#define RST_PIN 22
#define LED_PIN 2

MFRC522 rfid(SS_PIN, RST_PIN);
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

String lastUID = "";
unsigned long lastScanTime = 0;
bool firebaseReady = false;
bool timeReady = false;

void blinkLed(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(delayMs);
    digitalWrite(LED_PIN, LOW);
    delay(delayMs);
  }
}

String getDateKey() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return "";
  char buf[11];
  strftime(buf, sizeof(buf), "%Y-%m-%d", &timeinfo);
  return String(buf);
}

String getTimeStr() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return "";
  char buf[9];
  strftime(buf, sizeof(buf), "%H:%M:%S", &timeinfo);
  return String(buf);
}

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

void setupTime() {
  configTime(GMT_OFFSET, DST_OFFSET, NTP_SERVER);
  Serial.print("Syncing time");
  struct tm timeinfo;
  int attempts = 0;
  while (!getLocalTime(&timeinfo) && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (attempts < 20) {
    Serial.println();
    Serial.println("Time synced: " + getDateKey() + " " + getTimeStr());
    timeReady = true;
  } else {
    Serial.println();
    Serial.println("Time sync failed! Scans will still work but time may be off.");
  }
}

void connectFirebase() {
  config.api_key = FIREBASE_API_KEY;
  auth.user.email = FIREBASE_EMAIL;
  auth.user.password = FIREBASE_PASSWORD;
  config.token_status_callback = tokenStatusCallback;

  Firebase.begin(&config, &auth);
  Firebase.reconnectNetwork(true);

  Serial.print("Authenticating");
  int attempts = 0;
  while (!Firebase.ready() && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (Firebase.ready()) {
    Serial.println("Firebase ready!");
    firebaseReady = true;
  } else {
    Serial.println("Firebase auth failed! Check API key and credentials.");
  }
}

void processScan(String uid) {
  String dateKey = getDateKey();
  String timeStr = getTimeStr();

  if (dateKey == "" || timeStr == "") {
    Serial.println("Time not available, writing raw scan");
    // Write raw scan as fallback
    FirebaseJson json;
    json.set("fields/uid/stringValue", uid);
    json.set("fields/scannedAt/stringValue", String(millis()));
    String path = "projects/" + String(FIREBASE_PROJECT_ID) + "/databases/(default)/documents/scans/" + uid + "_" + String(millis());
    Firebase.Firestore.createDocument(&fbdo, FIREBASE_PROJECT_ID, "", path.c_str(), json.raw());
    return;
  }

  String docId = dateKey + "_" + uid;
  String docPath = "attendance/" + docId;

  // Check if attendance record exists for today
  if (Firebase.Firestore.getDocument(&fbdo, FIREBASE_PROJECT_ID, "", docPath.c_str(), "")) {
    // Document exists - check if checkOut is null
    FirebaseJson response;
    response.setJsonData(fbdo.payload());

    FirebaseJsonData checkOutData;
    response.get(checkOutData, "fields/checkOut/nullValue");

    if (checkOutData.success) {
      // checkOut is null → this is CHECK OUT
      FirebaseJson updateJson;
      updateJson.set("fields/checkOut/stringValue", timeStr);

      if (Firebase.Firestore.patchDocument(&fbdo, FIREBASE_PROJECT_ID, "", docPath.c_str(), updateJson.raw(), "checkOut")) {
        Serial.println("CHECK OUT: " + uid + " at " + timeStr);
        blinkLed(2, 150);
      } else {
        Serial.println("Error updating checkout: " + fbdo.errorReason());
        blinkLed(5, 80);
      }
    } else {
      // Already checked out today
      Serial.println("ALREADY DONE: " + uid + " (already checked in and out today)");
      blinkLed(3, 300);
    }
  } else {
    // No record exists → this is CHECK IN
    // First get employee info
    String empPath = "employees/" + uid;
    String empName = "Unknown";
    String empId = "";

    if (Firebase.Firestore.getDocument(&fbdo, FIREBASE_PROJECT_ID, "", empPath.c_str(), "")) {
      FirebaseJson empJson;
      empJson.setJsonData(fbdo.payload());
      FirebaseJsonData nameData, idData;
      empJson.get(nameData, "fields/name/stringValue");
      empJson.get(idData, "fields/employeeId/stringValue");
      if (nameData.success) empName = nameData.stringValue;
      if (idData.success) empId = idData.stringValue;
    } else {
      Serial.println("UNKNOWN CARD: " + uid);
      blinkLed(5, 80);
      return;
    }

    // Create attendance record
    FirebaseJson attJson;
    attJson.set("fields/uid/stringValue", uid);
    attJson.set("fields/employeeId/stringValue", empId);
    attJson.set("fields/employeeName/stringValue", empName);
    attJson.set("fields/dateKey/stringValue", dateKey);
    attJson.set("fields/checkIn/stringValue", timeStr);
    attJson.set("fields/checkOut/nullValue", (const char*)NULL);

    if (Firebase.Firestore.createDocument(&fbdo, FIREBASE_PROJECT_ID, "", docPath.c_str(), attJson.raw())) {
      Serial.println("CHECK IN: " + empName + " (" + uid + ") at " + timeStr);
      blinkLed(1, 200);
    } else {
      Serial.println("Error creating attendance: " + fbdo.errorReason());
      blinkLed(5, 80);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println();
  Serial.println("================================");
  Serial.println("  TechCADD Attendance System");
  Serial.println("  ESP32 + RC522 + WiFi");
  Serial.println("================================");

  // 1. WiFi
  connectWiFi();

  // 2. Time sync
  setupTime();

  // 3. Firebase
  connectFirebase();

  // 4. RFID
  SPI.begin();
  rfid.PCD_Init();

  Serial.println();
  Serial.println("SYSTEM READY - Scan a card!");
  Serial.println("================================");

  // 3 blinks = all ready
  blinkLed(3, 150);
  digitalWrite(LED_PIN, HIGH);
}

void loop() {
  // Auto reconnect WiFi if disconnected
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected, reconnecting...");
    digitalWrite(LED_PIN, LOW);
    connectWiFi();
    digitalWrite(LED_PIN, HIGH);
  }

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

  Serial.println("Card scanned: " + uid);

  if (firebaseReady && Firebase.ready()) {
    processScan(uid);
  } else {
    Serial.println("Firebase not ready, trying to reconnect...");
    connectFirebase();
    if (firebaseReady) {
      processScan(uid);
    } else {
      Serial.println("Still not ready. Scan skipped.");
      blinkLed(5, 80);
    }
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}
