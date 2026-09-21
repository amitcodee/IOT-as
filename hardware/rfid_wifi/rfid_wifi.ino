/*
  TechCADD Attendance - ESP32 WiFi + Firebase
  LIBRARY NEEDED: MFRC522 (install from Arduino Library Manager)

  WIRING:
    RC522 SDA  -> GPIO 23
    RC522 SCK  -> GPIO 22
    RC522 MOSI -> GPIO 19
    RC522 MISO -> GPIO 18
    RC522 RST  -> GPIO 5
    RC522 3.3V -> 3.3V
    RC522 GND  -> GND
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Preferences.h>
#include <time.h>

// ============================================================
//  SETTINGS LIVE IN secrets.h (git-ignored) - NOT IN THIS FILE.
//  First time: copy secrets.h.example to secrets.h (same folder).
//  It holds ONLY: the WiFi name + password, the Firebase project
//  id + public web API key, a name for this reader, and the
//  timezone. There is NO email or password for Firebase here:
//  the reader signs in anonymously, shows up as "Pending" in the
//  web dashboard (Devices), and a Super Admin approves it there.
// ============================================================
#include "secrets.h"

static_assert(sizeof(MY_DEVICE_NAME) <= 41, "MY_DEVICE_NAME must be at most 40 characters");

// How long before an ID token expires (they last 60 min) we refresh it.
#define TOKEN_REFRESH_MS 2700000UL

#define SS_PIN   23
#define SCK_PIN  22
#define MOSI_PIN 19
#define MISO_PIN 18
#define RST_PIN  5
#define LED_PIN  2

MFRC522 rfid(SS_PIN, RST_PIN);

Preferences prefs;              // flash storage: keeps the sign-in across reboots
String idToken = "";            // short-lived (1 h) access token
String refreshToken = "";       // long-lived; stored in flash, never in the source code
String deviceUid = "";          // this reader's anonymous Firebase user id
String lastUID = "";
unsigned long lastScanTime = 0;
unsigned long tokenTime = 0;
unsigned long lastAuthTry = 0;

void blinkLed(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, LOW); delay(ms);
    digitalWrite(LED_PIN, HIGH); delay(ms);
  }
}

String getDate() {
  struct tm t;
  if (!getLocalTime(&t)) return "";
  char buf[11];
  strftime(buf, sizeof(buf), "%Y-%m-%d", &t);
  return String(buf);
}

String getTime2() {
  struct tm t;
  if (!getLocalTime(&t)) return "";
  char buf[9];
  strftime(buf, sizeof(buf), "%H:%M:%S", &t);
  return String(buf);
}

String parseField(String json, String field) {
  // Find the field name
  int fieldPos = json.indexOf("\"" + field + "\"");
  if (fieldPos < 0) return "";
  // Find "stringValue" after the field
  int svPos = json.indexOf("stringValue", fieldPos);
  if (svPos < 0) return "";
  // Find first quote after "stringValue"
  int q1 = json.indexOf("\"", svPos + 11);
  if (q1 < 0) return "";
  // Find second quote (this starts the actual value)
  int q2 = json.indexOf("\"", q1 + 1);
  if (q2 < 0) return "";
  // Find third quote (this ends the value)
  int q3 = json.indexOf("\"", q2 + 1);
  if (q3 < 0) return "";
  return json.substring(q2 + 1, q3);
}

int fsGet(String path, String &response) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;

  String url = "https://firestore.googleapis.com/v1/projects/";
  url += MY_PROJECT_ID;
  url += "/databases/(default)/documents/";
  url += path;

  http.begin(client, url);
  http.addHeader("Authorization", "Bearer " + idToken);
  http.setTimeout(10000);

  int code = http.GET();
  if (code == 200) response = http.getString();
  else response = "";
  http.end();
  return code;
}

bool fsPatch(String path, String body) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;

  String url = "https://firestore.googleapis.com/v1/projects/";
  url += MY_PROJECT_ID;
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

bool fsPatchField(String path, String body, String field) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;

  String url = "https://firestore.googleapis.com/v1/projects/";
  url += MY_PROJECT_ID;
  url += "/databases/(default)/documents/";
  url += path;
  url += "?updateMask.fieldPaths=";
  url += field;
  // Only update a record that still exists (e.g. don't resurrect one the employee just undid).
  url += "&currentDocument.exists=true";

  http.begin(client, url);
  http.addHeader("Authorization", "Bearer " + idToken);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);

  int code = http.PATCH(body);
  http.end();
  return (code == 200);
}

// ------------------------------------------------------------
//  Sign-in without any password (Firebase Anonymous Auth)
//   1st boot : create an anonymous user, keep its refresh token in flash,
//              register in the web dashboard as "Pending".
//   later    : trade the stored refresh token for a new ID token.
//  A Super Admin approves / revokes this reader in the web dashboard.
// ------------------------------------------------------------

// Value of the first  "key": "value"  pair in a JSON text ("" if not found).
String jsonStr(const String &json, const String &key) {
  int k = json.indexOf("\"" + key + "\"");
  if (k < 0) return "";
  int colon = json.indexOf(':', k);
  if (colon < 0) return "";
  int q1 = json.indexOf('"', colon + 1);
  if (q1 < 0) return "";
  int q2 = json.indexOf('"', q1 + 1);
  if (q2 < 0) return "";
  return json.substring(q1 + 1, q2);
}

// UTC time as 2026-09-21T09:30:00Z (the web dashboard shows it in the viewer's timezone).
String isoNow() {
  time_t now = time(nullptr);
  struct tm t;
  gmtime_r(&now, &t);
  char buf[25];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
  return String(buf);
}

// POST to a Firebase Auth endpoint. Returns the HTTP status (<= 0 on a network error).
int authPost(const String &url, const String &body, const char *contentType, String &response) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, url);
  http.addHeader("Content-Type", contentType);
  http.setTimeout(10000);
  int code = http.POST(body);
  response = (code > 0) ? http.getString() : "";
  http.end();
  return code;
}

void saveSession() {
  prefs.begin("rfid", false);
  prefs.putString("refresh", refreshToken);
  prefs.putString("uid", deviceUid);
  prefs.end();
}

void loadSession() {
  prefs.begin("rfid", true);
  refreshToken = prefs.getString("refresh", "");
  deviceUid = prefs.getString("uid", "");
  prefs.end();
}

void clearSession() {
  prefs.begin("rfid", false);
  prefs.clear();
  prefs.end();
  refreshToken = "";
  deviceUid = "";
  idToken = "";
}

// First boot: anonymous sign-in. There is no email or password anywhere.
bool registerAnonymous() {
  String resp;
  String url = "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=";
  url += MY_API_KEY;
  int code = authPost(url, "{\"returnSecureToken\":true}", "application/json", resp);
  if (code != 200) {
    Serial.println("Anonymous sign-in failed, HTTP " + String(code));
    if (resp.indexOf("OPERATION_NOT_ALLOWED") >= 0 || resp.indexOf("ADMIN_ONLY_OPERATION") >= 0) {
      Serial.println("-> Turn on 'Anonymous' in Firebase console > Authentication > Sign-in method.");
    }
    return false;
  }
  String newToken = jsonStr(resp, "idToken");
  String newRefresh = jsonStr(resp, "refreshToken");
  String newUid = jsonStr(resp, "localId");
  if (newToken.length() < 100 || newRefresh == "" || newUid == "") {
    Serial.println("Anonymous sign-in: unexpected reply");
    return false;
  }
  idToken = newToken;
  refreshToken = newRefresh;
  deviceUid = newUid;
  tokenTime = millis();
  saveSession();
  return true;
}

// Trade the stored refresh token for a fresh ID token.
// Returns 1 = ok, 0 = could not (network) - try again later,
//        -1 = the saved sign-in is no longer valid (user deleted / disabled) - register again.
int refreshIdToken() {
  String resp;
  String url = "https://securetoken.googleapis.com/v1/token?key=";
  url += MY_API_KEY;
  int code = authPost(url, "grant_type=refresh_token&refresh_token=" + refreshToken,
                      "application/x-www-form-urlencoded", resp);
  if (code == 200) {
    String newToken = jsonStr(resp, "id_token");
    String newRefresh = jsonStr(resp, "refresh_token");
    if (newToken.length() < 100) return 0;
    idToken = newToken;
    tokenTime = millis();
    if (newRefresh != "" && newRefresh != refreshToken) {
      refreshToken = newRefresh;
      saveSession();
    }
    return 1;
  }
  if (code == 400 || code == 401) return -1;
  return 0;
}

// Tell the web dashboard this reader exists. It appears in Devices as "Pending".
// currentDocument.exists=false: only ever creates, never overwrites.
void announceDevice() {
  String body = "{\"fields\":{";
  body += "\"name\":{\"stringValue\":\"" MY_DEVICE_NAME "\"},";
  body += "\"requestedAt\":{\"stringValue\":\"" + isoNow() + "\"}";
  body += "}}";
  fsPatch("devices/" + deviceUid + "?currentDocument.exists=false", body);
}

// "Last seen" on the dashboard. If the admin removed this reader's entry, re-announce it.
void heartbeat() {
  String body = "{\"fields\":{\"lastSeenAt\":{\"stringValue\":\"" + isoNow() + "\"}}}";
  if (!fsPatchField("devices/" + deviceUid, body, "lastSeenAt")) announceDevice();
}

// Make sure we hold a usable ID token. Returns false if none could be obtained right now.
bool ensureSession() {
  if (refreshToken == "") {
    if (!registerAnonymous()) return false;
    announceDevice();
    Serial.println("NEW READER registered. ID: " + deviceUid);
    Serial.println("-> A Super Admin must click APPROVE for it in the web dashboard (Devices).");
    return true;
  }
  if (idToken == "" || (millis() - tokenTime) > TOKEN_REFRESH_MS) {
    int r = refreshIdToken();
    if (r == -1) {
      Serial.println("Saved sign-in is no longer valid - registering again");
      clearSession();
      return ensureSession();
    }
    if (r == 1) heartbeat();
    if (r == 0 && idToken == "") return false;
  }
  return idToken != "";
}

void processScan(String uid) {
  String dateKey = getDate();
  String timeStr = getTime2();

  if (dateKey == "" || timeStr == "") {
    Serial.println("Time not ready");
    blinkLed(5, 80);
    return;
  }

  // Check if employee exists. Only a 404 means "unknown card"; any other failure (network, expired
  // token, rules) is a lookup error and must NOT be reported as an unknown card.
  String empResp;
  int empCode = fsGet("employees/" + uid, empResp);
  if (empCode == 404) {
    Serial.println("UNKNOWN CARD: " + uid);
    blinkLed(5, 80);
    return;
  }
  if (empCode == 403) {
    // Signed in, but the database refuses us: this reader is not approved (or was revoked).
    Serial.println("NOT APPROVED: a Super Admin must approve this reader in the web dashboard > Devices.");
    Serial.println("Reader ID: " + deviceUid);
    blinkLed(2, 600);
    return;
  }
  if (empCode != 200) {
    Serial.println("Employee lookup failed, HTTP " + String(empCode));
    if (empCode == 401) idToken = "";  // token expired: log in again on the next tap
    blinkLed(5, 80);
    return;
  }
  Serial.println("Employee found");

  // Check today's attendance. Ask Firestore for ONLY the checkOut field so the reply is unambiguous:
  //   checkOut is set   -> {"fields":{"checkOut":{"stringValue":"17:30:00"}}}
  //   checkOut is null  -> {"fields":{"checkOut":{"nullValue":null}}}
  //   checkOut missing  -> no "fields" at all
  // (Searching the whole document for "nullValue" mistook a null checkOutLocation for a null checkOut.)
  String docId = dateKey + "_" + uid;
  String attResp;
  int attCode = fsGet("attendance/" + docId + "?mask.fieldPaths=checkOut", attResp);

  // Never write on a failed read: only 404 (no record yet) means "check in".
  if (attCode != 200 && attCode != 404) {
    Serial.println("Attendance lookup failed, HTTP " + String(attCode));
    if (attCode == 401) idToken = "";
    blinkLed(5, 80);
    return;
  }

  if (attCode == 404) {
    // No record → CHECK IN (only save uid, dateKey, checkIn)
    String body = "{\"fields\":{";
    body += "\"uid\":{\"stringValue\":\"" + uid + "\"},";
    body += "\"dateKey\":{\"stringValue\":\"" + dateKey + "\"},";
    body += "\"checkIn\":{\"stringValue\":\"" + timeStr + "\"},";
    body += "\"checkOut\":{\"nullValue\":null}";
    body += "}}";

    // currentDocument.exists=false: create only, never overwrite a record that appeared meanwhile.
    if (fsPatch("attendance/" + docId + "?currentDocument.exists=false", body)) {
      Serial.println("CHECK IN: " + uid + " at " + timeStr);
      blinkLed(1, 200);
    } else {
      Serial.println("Write failed");
      blinkLed(5, 80);
    }
    return;
  }

  // Record exists — with the mask above, a "stringValue" anywhere in the reply means checkOut is set.
  bool hasCheckOut = attResp.indexOf("\"stringValue\"") >= 0;

  if (!hasCheckOut) {
    // CHECK OUT
    String body = "{\"fields\":{";
    body += "\"checkOut\":{\"stringValue\":\"" + timeStr + "\"}";
    body += "}}";

    if (fsPatchField("attendance/" + docId, body, "checkOut")) {
      Serial.println("CHECK OUT: " + uid + " at " + timeStr);
      blinkLed(2, 150);
    } else {
      Serial.println("Update failed");
      blinkLed(5, 80);
    }
    return;
  }

  Serial.println("ALREADY DONE: " + uid);
  blinkLed(3, 300);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println();
  Serial.println("================================");
  Serial.println("  TechCADD Attendance System");
  Serial.println("================================");

  Serial.print("WiFi connecting");
  WiFi.mode(WIFI_STA);
  WiFi.begin(MY_WIFI_SSID, MY_WIFI_PASS);
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
    Serial.println("WiFi FAILED!");
    delay(5000);
    ESP.restart();
  }

  // Test internet connection
  Serial.print("Internet test: ");
  WiFiClientSecure testClient;
  testClient.setInsecure();
  if (testClient.connect("www.google.com", 443)) {
    Serial.println("OK");
    testClient.stop();
  } else {
    Serial.println("FAILED - No internet!");
  }

  configTime(MY_GMT_OFFSET, 0, "pool.ntp.org", "time.google.com", "time.nist.gov");
  Serial.print("Time sync");
  struct tm t;
  tries = 0;
  while (!getLocalTime(&t, 1000) && tries < 30) {
    delay(1000);
    Serial.print(".");
    tries++;
  }
  Serial.println();
  if (tries < 30) {
    char buf[20];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &t);
    Serial.print("Time: ");
    Serial.println(buf);
  } else {
    Serial.println("Time sync failed, restarting...");
    delay(3000);
    ESP.restart();
  }

  loadSession();
  if (ensureSession()) Serial.println("Signed in. Reader ID: " + deviceUid);
  else Serial.println("Sign-in FAILED - will retry automatically");

  SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, SS_PIN);
  rfid.PCD_Init();
  delay(100);

  Serial.println();
  Serial.println("READY - Scan a card!");
  Serial.println("================================");
  blinkLed(3, 150);
  digitalWrite(LED_PIN, HIGH);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost...");
    WiFi.begin(MY_WIFI_SSID, MY_WIFI_PASS);
    int tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 20) {
      delay(500);
      tries++;
    }
    if (WiFi.status() != WL_CONNECTED) return;
    Serial.println("WiFi back");
  }

  // Keep the sign-in fresh (and "last seen" on the dashboard current) even when nobody taps a card.
  // Not more often than once a minute if the network is down.
  if ((refreshToken == "" || (millis() - tokenTime) > TOKEN_REFRESH_MS) && (millis() - lastAuthTry) > 60000UL) {
    lastAuthTry = millis();
    ensureSession();
  }

  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  if (uid == lastUID && (millis() - lastScanTime) < 3000) return;
  lastUID = uid;
  lastScanTime = millis();

  Serial.print("Card: ");
  Serial.println(uid);

  blinkLed(1, 100);

  if (!ensureSession()) {
    Serial.println("No token");
    blinkLed(5, 80);
    return;
  }

  processScan(uid);
}
