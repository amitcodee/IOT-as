# TechCADD Attendance System - Setup Guide

---

## HOW IT WORKS

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
- You run the dashboard **locally** on your laptop (`localhost:3000`)
- Data is stored in Firebase — accessible from any device on your network
- **No laptop needed at the scanner** — just ESP32 + power adapter + WiFi

---

## WHAT YOU NEED

| Item | Purpose |
|------|---------|
| ESP32 DevKit V1 | Main controller |
| RC522 RFID Module | Card reader |
| RFID Cards/Tags | Employee cards |
| 5V USB Power Adapter | Powers ESP32 (phone charger works) |
| USB Cable | Connects ESP32 to power adapter |
| Office WiFi (2.4 GHz) | ESP32 connects to internet |
| Firebase Account | Free database + auth |
| Node.js installed | Runs the local dashboard server |

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

## STEP 4: CONFIGURE THE LOCAL DASHBOARD

### 4.1 Install Node.js

If you don't have Node.js, download and install from https://nodejs.org (LTS version).

### 4.2 Set up .env file

1. Open the `rfid-attendance` folder
2. Copy `.env.example` to `.env`
3. Fill in your Firebase config values in `.env`:

```
APP_NAME=TechCADD Attendance
PORT=3000

FIREBASE_API_KEY=AIzaSy_your_key_here
FIREBASE_AUTH_DOMAIN=techcadd-attendance.firebaseapp.com
FIREBASE_PROJECT_ID=techcadd-attendance
FIREBASE_STORAGE_BUCKET=techcadd-attendance.appspot.com
FIREBASE_MESSAGING_SENDER_ID=123456789
FIREBASE_APP_ID=1:123456789:web:abc123
FIREBASE_MEASUREMENT_ID=
```

### 4.3 Start the Dashboard

Open terminal in the `rfid-attendance` folder and run:

```bash
npm start
```

Or:

```bash
node server.mjs
```

Dashboard opens at:

```
http://localhost:3000
```

Sign in with the email/password you created in Step 2.

---

## STEP 5: WIRE THE RC522 TO ESP32

```
RC522 Pin      ESP32 Pin
---------      ---------
SDA       ---> GPIO 5
SCK       ---> GPIO 18
MOSI      ---> GPIO 23
MISO      ---> GPIO 19
RST       ---> GPIO 22
3.3V      ---> 3.3V
GND       ---> GND
```

WARNING: Use **3.3V NOT 5V**. The RC522 runs on 3.3V.

---

## STEP 6: UPLOAD WIFI FIRMWARE TO ESP32

The ESP32 connects to WiFi and writes directly to Firebase. **No extra Firebase library needed** — uses built-in HTTP client.

### 6.1 Install Arduino IDE Libraries

Open Arduino IDE → Sketch → Include Library → Manage Libraries:

1. Search **MFRC522** → Install
2. Search **ArduinoJson** (by Benoit Blanchon) → Install

Only 2 libraries needed. Everything else is built into ESP32.

### 6.2 Open the Firmware File

1. Open Arduino IDE
2. Open the file: `arduino/rfid_wifi/rfid_wifi.ino`
3. **Edit the settings** at the top of the file:

```cpp
#define WIFI_SSID       "YOUR_OFFICE_WIFI_NAME"
#define WIFI_PASSWORD   "YOUR_WIFI_PASSWORD"

#define FIREBASE_API_KEY      "YOUR_FIREBASE_API_KEY"
#define FIREBASE_PROJECT_ID   "YOUR_FIREBASE_PROJECT_ID"
#define FIREBASE_EMAIL        "YOUR_FIREBASE_AUTH_EMAIL"
#define FIREBASE_PASSWORD     "YOUR_FIREBASE_AUTH_PASSWORD"
```

Example:

```cpp
#define WIFI_SSID       "TechCADD_Office"
#define WIFI_PASSWORD   "office@2026"

#define FIREBASE_API_KEY      "AIzaSyB1234abcd5678efgh"
#define FIREBASE_PROJECT_ID   "techcadd-attendance"
#define FIREBASE_EMAIL        "admin@techcadd.com"
#define FIREBASE_PASSWORD     "your-secure-password"
```

### 6.3 Set Timezone (if not India)

Default is India (+5:30). Change this line for other timezones:

```cpp
#define GMT_OFFSET   19800   // India = +5:30 = 19800 seconds
```

| Timezone | GMT_OFFSET |
|----------|-----------|
| India (IST +5:30) | 19800 |
| Dubai (GST +4:00) | 14400 |
| London (GMT +0:00) | 0 |
| US Eastern (-5:00) | -18000 |
| Singapore (+8:00) | 28800 |

### 6.4 Upload to ESP32

1. Plug ESP32 into your laptop with USB cable
2. In Arduino IDE:
   - Tools → Board → **ESP32 Dev Module**
   - Tools → Port → select your ESP32 port (e.g., **COM5**)
3. Click **Upload** (arrow icon)
   - If upload fails, hold the **BOOT** button on ESP32 while uploading
4. Open **Tools → Serial Monitor** (baud: **115200**)
5. You should see:

```
================================
  TechCADD Attendance System
  ESP32 + RC522 + WiFi
================================
Connecting to WiFi....
WiFi connected: 192.168.1.105
Syncing time....
Time: 2026-07-11 14:30:45
Firebase login OK

SYSTEM READY - Scan a card!
================================
```

6. Tap a card — you should see:

```
Card: 82510704
CHECK IN: Aarav Patel at 14:31:02
```

7. Tap same card again:

```
Card: 82510704
CHECK OUT: Aarav Patel at 18:05:33
```

### 6.5 Power Without Laptop

Once firmware is uploaded and tested:

1. Unplug ESP32 from laptop
2. Plug into any **5V USB power adapter** (phone charger)
3. Place near office entrance with RC522 reader accessible
4. ESP32 boots, connects to WiFi, starts reading cards **automatically**
5. **No laptop needed at the scanner**

---

## STEP 7: ADD EMPLOYEES & ASSIGN CARDS

1. Open `http://localhost:3000` on your laptop
2. Sign in
3. Go to **Employees** tab
4. For each employee:
   - Type the card UID (read from Serial Monitor or `test.py`)
   - Or click **Connect Reader** → **Scan Card to Assign UID** (if ESP32 is connected via USB)
   - Enter: Name, Employee ID, Department, Role, Phone
   - Click **Save Employee**
5. Now when that employee taps their card, their name shows in attendance

### Reading Card UIDs with test.py

If you need to find a card's UID:

```bash
python test.py
```

Connect ESP32 via USB, select the COM port, tap cards — UIDs will be printed.

---

## RUNNING DAILY

### Start the dashboard:
```bash
cd rfid-attendance
npm start
```
Open `http://localhost:3000` in browser.

### ESP32 scanner:
Just make sure it's plugged into power and WiFi is on. It works automatically.

### View attendance:
- **Dashboard tab** → today's attendance
- **Attendance tab** → filter by date range
- **Employee View** → click View on any employee → see monthly attendance, hours, remarks

---

## FINAL SETUP CHECKLIST

```
[  ] Firebase project created
[  ] Auth enabled, admin user created
[  ] Firestore database created with rules
[  ] .env file configured with Firebase values
[  ] npm start works, dashboard opens at localhost:3000
[  ] Arduino libraries installed (MFRC522 + ArduinoJson)
[  ] WiFi + Firebase config edited in rfid_wifi.ino
[  ] Firmware uploaded to ESP32 and tested
[  ] ESP32 plugged into power adapter (standalone)
[  ] Employees added and RFID cards assigned
[  ] Test: tap card → check dashboard → attendance appears
```

---

## LED STATUS GUIDE (ESP32)

| LED Behavior | Meaning |
|-------------|---------|
| Blinking slowly | Connecting to WiFi |
| Solid ON | WiFi connected, waiting for cards |
| 1 quick blink | CHECK IN successful |
| 2 quick blinks | CHECK OUT successful |
| 3 quick blinks on boot | System fully ready |
| 3 slow blinks | Already checked in and out today |
| 5 rapid blinks | Error (unknown card / connection error) |
| OFF | No power |

---

## HOW SCAN LOGIC WORKS

```
Employee taps card on reader
       │
       ▼
ESP32 reads UID from card
       │
       ▼
ESP32 checks: is this UID in "employees" collection?
       │
   NO ─┤──> 5 rapid blinks (unknown card)
       │
   YES─┤──> Is there an attendance record for today?
       │         │
       │     NO ─┤──> CREATE record with checkIn time (1 blink)
       │         │
       │     YES─┤──> Is checkOut empty?
       │              │
       │          YES─┤──> UPDATE record with checkOut time (2 blinks)
       │              │
       │           NO─┤──> Already done today (3 slow blinks)
```

---

## ARCHITECTURE DIAGRAM

```
┌─────────────────────────────────────────────────────────────┐
│                        OFFICE                                │
│                                                              │
│   ┌──────────┐    ┌──────────┐    ┌──────────────────────┐  │
│   │  RFID    │───>│  ESP32   │───>│  Office WiFi Router  │──┼──> Internet
│   │  RC522   │    │          │    │   (2.4 GHz only)     │  │
│   └──────────┘    └──────────┘    └──────────────────────┘  │
│                    powered by                                │
│                    USB charger                               │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ (REST API over HTTPS)
                           ▼
                 ┌──────────────────┐
                 │  Firebase Cloud  │
                 │  ┌────────────┐  │
                 │  │ Firestore  │  │  ← employees, attendance, remarks
                 │  └────────────┘  │
                 │  ┌────────────┐  │
                 │  │   Auth     │  │  ← login credentials
                 │  └────────────┘  │
                 └──────────────────┘
                           │
                           ▼
                    ┌────────────┐
                    │  Your PC   │
                    │ localhost  │
                    │   :3000   │
                    └────────────┘
                    Dashboard runs
                    locally on your
                    laptop/PC
```

---

## COST

| Service | Cost |
|---------|------|
| Firebase (Spark Plan) | FREE (50K reads/day, 20K writes/day) |
| ESP32 + RC522 | One-time ~₹500-800 |
| RFID Cards | ~₹10-20 per card |

For a small office (under 50 employees), everything stays within the free tier.

---

## TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| `npm start` fails | Make sure Node.js is installed. Run `node -v` to check. |
| Dashboard won't load | Check `.env` file has correct Firebase values. |
| Login fails | Make sure you created a user in Firebase Auth (Step 2). |
| ESP32 won't connect to WiFi | Check SSID and password. WiFi must be **2.4 GHz** (ESP32 doesn't support 5 GHz). |
| "Firebase login failed" in Serial Monitor | Verify API key and email/password in the firmware code. |
| Card taps but nothing in dashboard | Check Serial Monitor for errors. Verify Firestore rules allow writes. |
| Upload fails in Arduino IDE | Hold the **BOOT** button on ESP32 while uploading. |
| Serial Monitor shows garbage | Set baud rate to **115200**. |
| "MFRC522.h: No such file" | Install: Sketch → Include Library → Manage Libraries → search "MFRC522" → Install. |
| "ArduinoJson.h: No such file" | Install: search "ArduinoJson" by Benoit Blanchon → Install. |
| Time shows wrong | Change `GMT_OFFSET` in the code (see timezone table in Step 6.3). |
| Card not detected | Hold card within 2-3 cm of the RC522 reader coil. |

---

## FILES

```
rfid-attendance/
   arduino/
      rfid_scanner/
         rfid_scanner.ino    ← USB-serial mode (needs laptop connected)
      rfid_wifi/
         rfid_wifi.ino       ← WiFi mode (standalone, no laptop at scanner)
   web/
      index.html             ← Dashboard UI
      app.js                 ← Dashboard logic
      styles.css             ← Styling
      logo.png               ← TechCADD logo
   server.mjs               ← Local server (reads .env, serves dashboard)
   .env                     ← Your Firebase config (create from .env.example)
   .env.example             ← Template
   test.py                  ← UID reader utility
   setup.md                 ← This file
   run.md                   ← Quick reference
```

---

## FUTURE: HOST ONLINE

When you're ready to access the dashboard from anywhere (not just localhost), see the hosting options:

- **Firebase Hosting** (free) — `firebase deploy --only hosting`
- **Vercel** (free) — push to GitHub, import on vercel.com
- **Netlify** (free) — push to GitHub, import on netlify.com

For now, `localhost:3000` works perfectly for local use.
