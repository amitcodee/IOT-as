/*
  TechCADD Attendance - ESP32 WiFi + Firebase
  LIBRARY NEEDED: MFRC522 (install from Arduino Library Manager)

  WIRING:
    RC522 SDA  -> GPIO 5
    RC522 SCK  -> GPIO 18
    RC522 MOSI -> GPIO 23
    RC522 MISO -> GPIO 19
    RC522 RST  -> GPIO 22
    RC522 3.3V -> 3.3V
    RC522 GND  -> GND
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>
#include <time.h>

// ============================================================
//  CHANGE THESE 6 VALUES TO YOUR OWN
// ============================================================
#define MY_WIFI_SSID       "amit"
#define MY_WIFI_PASS       "Amit@1322"
#define MY_API_KEY         "AIzaSyCxyzV5yPD05P2Ij_oFLhwbtapZ5Wo0UTI"
#define MY_PROJECT_ID      "iot-tce-db97e"
#define MY_AUTH_EMAIL      "amithsp.techcadd@gmail.com"
#define MY_AUTH_PASS       "Amit@123"
#define MY_GMT_OFFSET      19800

// India=19800 Dubai=14400 London=0 Singapore=28800
// ============================================================

#define SS_PIN  5
#define RST_PIN 22
#define LED_PIN 2

MFRC522 rfid(SS_PIN, RST_PIN);

String idToken = "";
String lastUID = "";
unsigned long lastScanTime = 0;
unsigned long tokenTime = 0;

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
  String search = "\"" + field + "\":{\"stringValue\":\"";
  int start = json.indexOf(search);
  if (start < 0) return "";
  start += search.length();
  int end = json.indexOf("\"", start);
  if (end < 0) return "";
  return json.substring(start, end);
}

bool firebaseLogin() {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;

  String url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=";
  url += MY_API_KEY;

  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);

  String body = "{\"email\":\"";
  body += MY_AUTH_EMAIL;
  body += "\",\"password\":\"";
  body += MY_AUTH_PASS;
  body += "\",\"returnSecureToken\":true}";

  int code = http.POST(body);
  bool ok = false;

  if (code == 200) {
    WiFiClient* stream = http.getStreamPtr();
    String line = "";
    while (stream->available() || stream->connected()) {
      if (stream->available()) {
        char c = stream->read();
        line += c;
        if (line.endsWith("\"idToken\": \"") || line.endsWith("\"idToken\":\"")) {
          // Read the token value
          idToken = "";
          while (stream->available() || stream->connected()) {
            if (stream->available()) {
              char tc = stream->read();
              if (tc == '"') break;
              idToken += tc;
            }
          }
          if (idToken.length() > 100) {
            tokenTime = millis();
            ok = true;
            Serial.println("Token OK, length: " + String(idToken.length()));
          }
          break;
        }
        // Keep line short to save memory
        if (line.length() > 200) {
          line = line.substring(line.length() - 50);
        }
      }
    }
  } else {
    Serial.print("Login error: ");
    Serial.println(code);
    Serial.println(http.getString());
  }
  http.end();
  return ok;
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

  http.begin(client, url);
  http.addHeader("Authorization", "Bearer " + idToken);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);

  int code = http.PATCH(body);
  http.end();
  return (code == 200);
}

void processScan(String uid) {
  String dateKey = getDate();
  String timeStr = getTime2();

  if (dateKey == "" || timeStr == "") {
    Serial.println("Time not ready");
    blinkLed(5, 80);
    return;
  }

  String empResp;
  int empCode = fsGet("employees/" + uid, empResp);
  if (empCode != 200) {
    Serial.println("UNKNOWN CARD");
    blinkLed(5, 80);
    return;
  }

  String empName = parseField(empResp, "name");
  String empId = parseField(empResp, "employeeId");
  if (empName == "") empName = "Unknown";

  String docId = dateKey + "_" + uid;
  String attResp;
  int attCode = fsGet("attendance/" + docId, attResp);

  if (attCode != 200) {
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
      blinkLed(1, 200);
    } else {
      Serial.println("Write failed");
      blinkLed(5, 80);
    }
    return;
  }

  bool hasCheckOut = (attResp.indexOf("\"checkOut\":{\"stringValue\"") > 0);

  if (!hasCheckOut) {
    String body = "{\"fields\":{";
    body += "\"checkOut\":{\"stringValue\":\"" + timeStr + "\"}";
    body += "}}";

    if (fsPatchField("attendance/" + docId, body, "checkOut")) {
      Serial.println("CHECK OUT: " + empName + " at " + timeStr);
      blinkLed(2, 150);
    } else {
      Serial.println("Update failed");
      blinkLed(5, 80);
    }
    return;
  }

  Serial.println("ALREADY DONE: " + empName);
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

  configTime(MY_GMT_OFFSET, 0, "pool.ntp.org");
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
  }

  if (firebaseLogin()) Serial.println("Login OK");
  else Serial.println("Login FAILED!");

  SPI.begin();
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

  if (idToken == "" || (millis() - tokenTime) > 3000000) {
    firebaseLogin();
  }

  if (idToken == "") {
    Serial.println("No token");
    blinkLed(5, 80);
    return;
  }

  processScan(uid);
}
