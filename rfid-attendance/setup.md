# TechCADD Attendance System - Live & Remote Setup

Set up the RFID attendance system so the ESP32 works **standalone in office** (no laptop needed)
and you can check attendance **from anywhere** on your phone or PC.

---

## HOW IT WORKS (REMOTE MODE)

```
OFFICE                                    CLOUD                         YOU (ANYWHERE)
┌──────────────┐                    ┌──────────────┐               ┌──────────────┐
│ ESP32 + RC522│── WiFi ──────────> │   Firebase   │ <──────────── │  Dashboard   │
│ (plugged to  │   writes card UID  │  Firestore   │  reads data   │  (browser)   │
│  power only) │   directly to DB   │              │               │              │
└──────────────┘                    └──────────────┘               └──────────────┘
```

- ESP32 connects to your **office WiFi**
- When employee taps card, ESP32 writes check-in/check-out **directly to Firebase**
- Dashboard is hosted online (free) — open from any browser, anywhere
- **No laptop or PC needed in office** — just ESP32 + power adapter + WiFi

---

## WHAT YOU NEED

| Item | Purpose |
|------|---------|
| ESP32 DevKit V1 | Main controller |
| RC522 RFID Module | Card reader |
| RFID Cards/Tags | Employee cards |
| 5V USB Power Adapter | Powers ESP32 (phone charger works) |
| USB Cable | Connects ESP32 to power adapter |
| Office WiFi | ESP32 connects to internet |
| Firebase Account | Free database + auth + hosting |
| GitHub Account | Free hosting via Vercel/Netlify (optional) |

---

## STEP 1: CREATE FIREBASE PROJECT

1. Go to https://console.firebase.google.com
2. Click **Add Project** → name it `techcadd-attendance` → Create
3. Once created, click the **Web** icon (</>) to add a web app
4. Register app name: `attendance-dashboard`
5. **Copy the Firebase config** — you'll need these values:
   ```
   apiKey: "AIzaSy..."
   authDomain: "techcadd-attendance.firebaseapp.com"
   projectId: "techcadd-attendance"
   storageBucket: "techcadd-attendance.appspot.com"
   messagingSenderId: "123456789"
   appId: "1:123456789:web:abc123"
   ```

---

## STEP 2: ENABLE FIREBASE AUTH

1. In Firebase Console → **Authentication** → **Get Started**
2. Click **Email/Password** → Enable → Save
3. Go to **Users** tab → **Add User**
4. Enter your email and password (this is your dashboard login)
   ```
   Email:    admin@techcadd.com
   Password: your-secure-password
   ```

---

## STEP 3: SET UP FIRESTORE DATABASE

1. In Firebase Console → **Firestore Database** → **Create Database**
2. Choose **Start in test mode** (you'll secure it later)
3. Select a region closest to your office (e.g., `asia-south1` for India)
4. After creation, go to **Rules** tab and paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

5. Click **Publish**

---

## STEP 4: UPLOAD WIFI FIRMWARE TO ESP32

The ESP32 needs new firmware that connects to WiFi and writes to Firebase directly
(instead of sending over USB serial).

### 4.1 Install Arduino IDE Libraries

Open Arduino IDE → Sketch → Include Library → Manage Libraries:
- Search and install **MFRC522**
- Search and install **Firebase ESP32 Client** (by Mobizt)
- Search and install **ArduinoJson**

If "Firebase ESP32 Client" is not found, install it manually:
1. Go to https://github.com/mobizt/Firebase-ESP-Client
2. Download ZIP → Arduino IDE → Sketch → Include Library → Add .ZIP Library

### 4.2 Create New Arduino File

Create a new file `arduino/rfid_wifi/rfid_wifi.ino` and paste the code below.

**IMPORTANT:** Replace the placeholder values with your actual WiFi and Firebase credentials.

```cpp
/*
  TechCADD Attendance - ESP32 WiFi + Firebase
  ESP32 reads RFID card → connects to WiFi → writes to Firestore

  WIRING (same as before):
    RC522   ->  ESP32
    SDA     ->  GPIO 5
    SCK     ->  GPIO 18
    MOSI    ->  GPIO 23
    MISO    ->  GPIO 19
    RST     ->  GPIO 22
    3.3V    ->  3.3V
    GND     ->  GND
*/

#include <WiFi.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>

// ===== YOUR SETTINGS - CHANGE THESE =====
#define WIFI_SSID       "YOUR_OFFICE_WIFI_NAME"
#define WIFI_PASSWORD   "YOUR_WIFI_PASSWORD"

#define FIREBASE_API_KEY      "YOUR_FIREBASE_API_KEY"
#define FIREBASE_PROJECT_ID   "YOUR_FIREBASE_PROJECT_ID"
#define FIREBASE_EMAIL        "YOUR_FIREBASE_AUTH_EMAIL"
#define FIREBASE_PASSWORD     "YOUR_FIREBASE_AUTH_PASSWORD"
// =========================================

#define SS_PIN  5
#define RST_PIN 22

MFRC522 rfid(SS_PIN, RST_PIN);
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

String lastUID = "";
unsigned long lastScanTime = 0;
bool firebaseReady = false;

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);

  // Connect to WiFi
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    digitalWrite(2, !digitalRead(2)); // blink while connecting
  }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());
  digitalWrite(2, HIGH); // solid LED = connected

  // Firebase setup
  config.api_key = FIREBASE_API_KEY;
  auth.user.email = FIREBASE_EMAIL;
  auth.user.password = FIREBASE_PASSWORD;
  config.token_status_callback = tokenStatusCallback;

  Firebase.begin(&config, &auth);
  Firebase.reconnectNetwork(true);

  // Wait for Firebase auth
  Serial.print("Authenticating");
  while (!Firebase.ready()) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nFirebase ready!");
  firebaseReady = true;

  // Init RFID
  SPI.begin();
  rfid.PCD_Init();
  Serial.println("RFID_READY - Scan a card");

  // Blink 3 times = all ready
  for (int i = 0; i < 3; i++) {
    digitalWrite(2, LOW); delay(150);
    digitalWrite(2, HIGH); delay(150);
  }
}

String getDateKey() {
  // Simple date from millis - for accurate dates, use NTP
  // This uses Firebase server timestamp instead
  return "";
}

String getTimeStr() {
  return "";
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

  Serial.println("Card scanned: " + uid);

  // Blink LED
  digitalWrite(2, LOW);
  delay(200);
  digitalWrite(2, HIGH);

  if (!firebaseReady || !Firebase.ready()) {
    Serial.println("Firebase not ready, skipping");
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }

  // Write scan to a "scans" queue collection
  // The dashboard web app will process these scans
  FirebaseJson json;
  json.set("uid", uid);
  json.set("timestamp", "discover");

  // Use server timestamp
  json.set("scannedAt/.sv", "timestamp");

  String docPath = "scans/" + uid + "_" + String(millis());
  if (Firebase.Firestore.createDocument(&fbdo, FIREBASE_PROJECT_ID, "", docPath.c_str(), json.raw())) {
    Serial.println("Scan saved to Firebase!");
  } else {
    Serial.println("Firebase error: " + fbdo.errorReason());
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}
```

### 4.3 Upload to ESP32

1. Open `rfid_wifi.ino` in Arduino IDE
2. **Edit the 4 settings** at the top with your actual values
3. Tools → Board → ESP32 Dev Module
4. Tools → Port → select your ESP32 port (e.g., COM5)
5. Click Upload
6. Open Serial Monitor (115200 baud) — you should see:
   ```
   Connecting to WiFi....
   WiFi connected: 192.168.1.105
   Authenticating...
   Firebase ready!
   RFID_READY - Scan a card
   ```
7. Tap a card — it should say "Scan saved to Firebase!"

### 4.4 Power Without Laptop

Once firmware is uploaded:
1. Unplug ESP32 from laptop
2. Plug ESP32 into any **5V USB power adapter** (phone charger)
3. ESP32 boots up, connects to WiFi, and starts reading cards automatically
4. **No laptop needed anymore**

---

## STEP 5: HOST THE DASHBOARD ONLINE (FREE)

You have 3 options. Pick one:

### Option A: Firebase Hosting (Recommended)

1. Install Firebase CLI:
   ```bash
   npm install -g firebase-tools
   ```

2. Login:
   ```bash
   firebase login
   ```

3. In your project folder (`rfid-attendance`), create `firebase.json`:
   ```json
   {
     "hosting": {
       "public": "web",
       "ignore": ["firebase.json", "**/.*"],
       "rewrites": [
         { "source": "/config.js", "destination": "/config.js" },
         { "source": "**", "destination": "/index.html" }
       ]
     }
   }
   ```

4. Create `web/config.js` with your Firebase config (since there's no server.mjs online):
   ```js
   window.__APP_CONFIG__ = {
     appName: "TechCADD Attendance",
     firebase: {
       apiKey: "YOUR_FIREBASE_API_KEY",
       authDomain: "YOUR_PROJECT.firebaseapp.com",
       projectId: "YOUR_PROJECT_ID",
       storageBucket: "YOUR_PROJECT.appspot.com",
       messagingSenderId: "YOUR_SENDER_ID",
       appId: "YOUR_APP_ID"
     }
   };
   ```

5. Deploy:
   ```bash
   firebase init hosting
   firebase deploy --only hosting
   ```

6. Your dashboard is now live at:
   ```
   https://YOUR_PROJECT_ID.web.app
   ```

### Option B: Vercel (Free)

1. Push your code to GitHub
2. Go to https://vercel.com → Import your repo
3. Set framework to "Other"
4. Set output directory to `web`
5. Add environment variables (same as .env file)
6. Deploy — get a free URL like `your-project.vercel.app`

### Option C: Netlify (Free)

1. Push code to GitHub
2. Go to https://netlify.com → New site from Git
3. Set publish directory to `web`
4. Create `web/config.js` with your Firebase config (same as Option A step 4)
5. Deploy — get a free URL

---

## STEP 6: PROCESS SCANS INTO ATTENDANCE

The ESP32 writes raw scans to a `scans` collection. You need to process them into attendance records.

### Option 1: Use Cloud Functions (Automatic)

Create a Firebase Cloud Function that triggers on new scan documents:

1. Initialize Cloud Functions:
   ```bash
   firebase init functions
   ```

2. In `functions/index.js`:
   ```js
   const functions = require("firebase-functions");
   const admin = require("firebase-admin");
   admin.initializeApp();
   const db = admin.firestore();

   exports.processScan = functions.firestore
     .document("scans/{scanId}")
     .onCreate(async (snap) => {
       const scan = snap.data();
       const uid = scan.uid;
       if (!uid) return;

       // Get employee
       const empSnap = await db.collection("employees").doc(uid).get();
       if (!empSnap.exists) return;
       const emp = empSnap.data();

       // Today's date
       const now = new Date();
       const dateKey = now.toISOString().slice(0, 10);
       const time = now.toTimeString().slice(0, 8);
       const docId = dateKey + "_" + uid;

       // Check existing attendance
       const attSnap = await db.collection("attendance").doc(docId).get();

       if (!attSnap.exists) {
         // Check IN
         await db.collection("attendance").doc(docId).set({
           uid,
           employeeId: emp.employeeId,
           employeeName: emp.name,
           dateKey,
           checkIn: time,
           checkOut: null,
         });
       } else if (!attSnap.data().checkOut) {
         // Check OUT
         await db.collection("attendance").doc(docId).update({
           checkOut: time,
         });
       }

       // Delete processed scan
       await snap.ref.delete();
     });
   ```

3. Deploy:
   ```bash
   firebase deploy --only functions
   ```

Now every card tap is automatically processed!

### Option 2: Dashboard Processes Scans (No Cloud Functions)

If you don't want Cloud Functions, the dashboard can process scans.
Keep a browser tab open with the dashboard — it already handles scan processing
via the Web Serial flow. Just use the dashboard's connect button when you're near the ESP32.

For fully remote (no browser open), Option 1 (Cloud Functions) is recommended.

---

## FINAL SETUP CHECKLIST

```
[ ] Firebase project created
[ ] Auth enabled, admin user created
[ ] Firestore database created with rules
[ ] ESP32 firmware uploaded with WiFi + Firebase credentials
[ ] ESP32 plugged into power adapter in office (no laptop)
[ ] Dashboard hosted online (Firebase Hosting / Vercel / Netlify)
[ ] Employees added in dashboard
[ ] RFID cards assigned to employees
[ ] Cloud Function deployed (for automatic scan processing)
[ ] Test: tap card in office → check dashboard from phone
```

---

## LED STATUS GUIDE (ESP32)

| LED Behavior | Meaning |
|-------------|---------|
| Blinking slowly | Connecting to WiFi |
| Solid ON | WiFi connected, waiting for cards |
| Quick blink | Card scanned successfully |
| 3 quick blinks | System fully ready (WiFi + Firebase + RFID) |
| OFF | No power or error |

---

## ARCHITECTURE DIAGRAM

```
┌─────────────────────────────────────────────────────────────┐
│                        OFFICE                                │
│                                                              │
│   ┌──────────┐    ┌──────────┐    ┌──────────────────────┐  │
│   │  RFID    │───>│  ESP32   │───>│  Office WiFi Router  │──┼──> Internet
│   │  RC522   │    │          │    │                      │  │
│   └──────────┘    └──────────┘    └──────────────────────┘  │
│                    powered by                                │
│                    USB charger                               │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ (writes to Firestore via WiFi)
                           ▼
                 ┌──────────────────┐
                 │  Firebase Cloud  │
                 │  ┌────────────┐  │
                 │  │ Firestore  │  │  ← employees, attendance, remarks
                 │  └────────────┘  │
                 │  ┌────────────┐  │
                 │  │   Auth     │  │  ← login credentials
                 │  └────────────┘  │
                 │  ┌────────────┐  │
                 │  │  Hosting   │  │  ← dashboard website
                 │  └────────────┘  │
                 └──────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐  ┌────────┐  ┌────────┐
         │ Phone  │  │ Laptop │  │ Tablet │
         │ Browser│  │ Browser│  │ Browser│
         └────────┘  └────────┘  └────────┘
              Access from ANYWHERE
```

---

## COST

| Service | Cost |
|---------|------|
| Firebase (Spark Plan) | FREE (50K reads/day, 20K writes/day) |
| Firebase Hosting | FREE (10 GB/month) |
| Vercel / Netlify | FREE tier available |
| ESP32 + RC522 | One-time ~₹500-800 |
| RFID Cards | ~₹10-20 per card |

For a small office (under 50 employees), everything stays within the free tier.

---

## TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| ESP32 won't connect to WiFi | Double-check SSID and password. WiFi must be 2.4 GHz (ESP32 doesn't support 5 GHz). |
| Firebase auth fails on ESP32 | Verify API key and email/password are correct. |
| Card taps but nothing in database | Check Serial Monitor for errors. Make sure Firebase rules allow writes. |
| Dashboard shows no data | Make sure dashboard config matches same Firebase project. |
| ESP32 disconnects from WiFi | Add a WiFi reconnect check in loop. ESP32 auto-reconnects in most cases. |
| "Quota exceeded" error | You've hit Firebase free tier limits. Reduce scan frequency or upgrade plan. |
