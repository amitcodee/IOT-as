/*
  TechCADD Attendance - ESP32 WiFi + Firebase (Lightweight)

  WIRING:
    RC522   ->  ESP32
    SDA     ->  GPIO 5
    SCK     ->  GPIO 18
    MOSI    ->  GPIO 23
    MISO    ->  GPIO 19
    RST     ->  GPIO 22
    3.3V    ->  3.3V
    GND     ->  GND

  LIBRARIES NEEDED:
    - MFRC522
    - ArduinoJson (by Benoit Blanchon)
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ArduinoJson.h>
#include <time.h>

// ============================================================
//  CHANGE THESE VALUES
// ============================================================
const char* WIFI_SSID       = "YOUR_OFFICE_WIFI_NAME";
const char* WIFI_PASSWORD   = "YOUR_WIFI_PASSWORD";

const char* API_KEY         = "YOUR_FIREBASE_API_KEY";
const char* PROJECT_ID      = "YOUR_FIREBASE_PROJECT_ID";
const char* AUTH_EMAIL      = "YOUR_FIREBASE_AUTH_EMAIL";
const char* AUTH_PASSWORD   = "YOUR_FIREBASE_AUTH_PASSWORD";

// India = 19800, Dubai = 14400, London = 0
const long GMT_OFFSET = 19800;
// ============================================================

#define SS_PIN  5
#define RST_PIN 22
#define LED_PIN 2

MFRC522 rfid(SS_PIN, RST_PIN);

String idToken = "";
String lastUID = "";
unsigned long lastScanTime = 0;
unsigned long tokenTime = 0;

void setup() {
  Serial.begin(115200);
  delay(1000);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println();
  Serial.println("================================");
  Serial.println("  TechCADD Attendance System");
  Serial.println("================================");

  // WiFi
  Serial.print("WiFi connecting");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 40) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    tries++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi OK: ");
    Serial.println(WiFi.localIP());
    digitalWrite(LED_PIN, HIGH);
  } else {
    Serial.println("WiFi FAILED! Check SSID/password.");
    Serial.println("Restarting in 5 seconds...");
    delay(5000);
    ESP.restart();
  }

  // Time
  configTime(GMT_OFFSET, 0, "pool.ntp.org");
  Serial.print("Time sync");
  struct tm t;
  tries = 0;
  while (!getLocalTime(&t) && tries < 15) {
    delay(500);
    Serial.print(".");
    tries++;
  }
  Serial.println();
  if (tries < 15) {
    char buf[20];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &t);
    Serial.print("Time: ");
    Serial.println(buf);
  } else {
    Serial.println("Time sync failed");
  }

  // Firebase login
  if (firebaseLogin()) {
    Serial.println("Login OK");
  } else {
    Serial.println("Login FAILED! Check API key and credentials.");
  }

  // RFID
  SPI.begin();
  rfid.PCD_Init();
  delay(100);

  Serial.println();
  Serial.println("READY - Scan a card!");
  Serial.println("================================");

  // 3 blinks = ready
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_PIN, LOW); delay(150);
    digitalWrite(LED_PIN, HIGH); delay(150);
  }
}

void loop() {
  // Reconnect WiFi if needed
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost, reconnecting...");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    int tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 20) {
      delay(500);
      tries++;
    }
    if (WiFi.status() != WL_CONNECTED) return;
    Serial.println("WiFi reconnected");
  }

  // Check for card
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  // Build UID
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  // Skip duplicate within 3 sec
  if (uid == lastUID && (millis() - lastScanTime) < 3000) return;
  lastUID = uid;
  lastScanTime = millis();

  Serial.print("Card: ");
  Serial.println(uid);

  // Refresh token if older than 50 min
  if (idToken == "" || (millis() - tokenTime) > 3000000) {
    firebaseLogin();
  }

  if (idToken == "") {
    Serial.println("No token, skip");
    blink(5, 80);
    return;
  }

  processScan(uid);
}

// ---- Blink ----
void blink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, LOW); delay(ms);
    digitalWrite(LED_PIN, HIGH); delay(ms);
  }
}

// ---- Date/Time ----
String getDate() {
  struct tm t;
  if (!getLocalTime(&t)) return "";
  char buf[11];
  strftime(buf, sizeof(buf), "%Y-%m-%d", &t);
  return String(buf);
}

String getTime() {
  struct tm t;
  if (!getLocalTime(&t)) return "";
  char buf[9];
  strftime(buf, sizeof(buf), "%H:%M:%S", &t);
  return String(buf);
}

// ---- Firebase Login ----
bool firebaseLogin() {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=";
  url += API_KEY;

  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);

  String body = "{\"email\":\"";
  body += AUTH_EMAIL;
  body += "\",\"password\":\"";
  body += AUTH_PASSWORD;
  body += "\",\"returnSecureToken\":true}";

  int code = http.POST(body);
  bool ok = false;

  if (code == 200) {
    String resp = http.getString();
    int start = resp.indexOf("\"idToken\":\"") + 11;
    int end = resp.indexOf("\"", start);
    if (start > 10 && end > start) {
      idToken = resp.substring(start, end);
      tokenTime = millis();
      ok = true;
    }
  } else {
    Serial.print("Login error: ");
    Serial.println(code);
  }

  http.end();
  return ok;
}

// ---- Firestore GET ----
int fsGet(String path, String &response) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = "https://firestore.googleapis.com/v1/projects/";
  url += PROJECT_ID;
  url += "/databases/(default)/documents/";
  url += path;

  http.begin(client, url);
  http.addHeader("Authorization", "Bearer " + idToken);
  http.setTimeout(10000);

  int code = http.GET();
  if (code == 200) {
    response = http.getString();
  } else {
    response = "";
  }
  http.end();
  return code;
}

// ---- Firestore PATCH ----
bool fsPatch(String path, String body) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = "https://firestore.googleapis.com/v1/projects/";
  url += PROJECT_ID;
  url += "/databases/(default)/documents/";
  url += path;

  http.begin(client, url);
  http.addHeader("Authorization", "Bearer " + idToken);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);

  int code = http.PATCH(body);
  http.end();
  return (code == 200);
}

// ---- Firestore PATCH with mask ----
bool fsPatchField(String path, String body, String field) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String url = "https://firestore.googleapis.com/v1/projects/";
  url += PROJECT_ID;
  url += "/databases/(default)/documents/";
  url += path;
  url += "?updateMask.fieldPaths=";
  url += field;

  http.begin(client, url);
  http.addHeader("Authorization", "Bearer " + idToken);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);

  int code = http.PATCH(body);
  http.end();
  return (code == 200);
}

// ---- Process Scan ----
void processScan(String uid) {
  String dateKey = getDate();
  String timeStr = getTime();

  if (dateKey == "" || timeStr == "") {
    Serial.println("Time not ready");
    blink(5, 80);
    return;
  }

  // Check employee exists
  String empResp;
  int empCode = fsGet("employees/" + uid, empResp);

  if (empCode != 200) {
    Serial.println("UNKNOWN CARD");
    blink(5, 80);
    return;
  }

  // Parse employee name
  String empName = parseField(empResp, "name");
  String empId = parseField(empResp, "employeeId");
  if (empName == "") empName = "Unknown";

  // Check today's attendance
  String docId = dateKey + "_" + uid;
  String attResp;
  int attCode = fsGet("attendance/" + docId, attResp);

  if (attCode != 200) {
    // No record → CHECK IN
    String body = "{\"fields\":{";
    body += "\"uid\":{\"stringValue\":\"" + uid + "\"},";
    body += "\"employeeId\":{\"stringValue\":\"" + empId + "\"},";
    body += "\"employeeName\":{\"stringValue\":\"" + empName + "\"},";
    body += "\"dateKey\":{\"stringValue\":\"" + dateKey + "\"},";
    body += "\"checkIn\":{\"stringValue\":\"" + timeStr + "\"},";
    body += "\"checkOut\":{\"nullValue\":null}";
    body += "}}";

    if (fsPatch("attendance/" + docId, body)) {
      Serial.println("CHECK IN: " + empName + " at " + timeStr);
      blink(1, 200);
    } else {
      Serial.println("Write failed");
      blink(5, 80);
    }
    return;
  }

  // Record exists — check if checkOut is null
  bool hasCheckOut = (attResp.indexOf("\"checkOut\":{\"stringValue\"") > 0);

  if (!hasCheckOut) {
    // CHECK OUT
    String body = "{\"fields\":{";
    body += "\"checkOut\":{\"stringValue\":\"" + timeStr + "\"}";
    body += "}}";

    if (fsPatchField("attendance/" + docId, body, "checkOut")) {
      Serial.println("CHECK OUT: " + empName + " at " + timeStr);
      blink(2, 150);
    } else {
      Serial.println("Update failed");
      blink(5, 80);
    }
    return;
  }

  Serial.println("ALREADY DONE: " + empName);
  blink(3, 300);
}

// ---- Parse field from Firestore JSON ----
String parseField(String json, String field) {
  String search = "\"" + field + "\":{\"stringValue\":\"";
  int start = json.indexOf(search);
  if (start < 0) return "";
  start += search.length();
  int end = json.indexOf("\"", start);
  if (end < 0) return "";
  return json.substring(start, end);
}
