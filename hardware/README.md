# Hardware (flash this onto the chip)

ESP32 + RC522 card reader firmware. This folder is **never deployed** to a server.

```
hardware/rfid_wifi/
├─ rfid_wifi.ino       the firmware
├─ secrets.h.example   template - copy to secrets.h
└─ secrets.h           YOUR settings (git-ignored, never committed)
```

**The chip holds only WiFi info** (plus the Firebase project id / public web key it reports to). There is no admin email, no password and no login for Firebase: the reader signs in anonymously and a Super Admin approves it in the web dashboard.

## What you need

ESP32 DevKit V1, RC522 RFID module, RFID cards, 7 jumper wires, a USB cable, a 5 V USB power adapter, 2.4 GHz WiFi (the ESP32 has no 5 GHz).

## 1. Wire the RC522

```
RC522 pin   ESP32 pin
---------   ---------
SDA    -->  GPIO 23
SCK    -->  GPIO 22
MOSI   -->  GPIO 19
MISO   -->  GPIO 18
RST    -->  GPIO 5
3.3V   -->  3.3V      (NOT 5V - the RC522 is a 3.3 V part)
GND    -->  GND
```

## 2. Arduino IDE

1. Install the ESP32 board package (Boards Manager → "esp32" by Espressif) and pick **ESP32 Dev Module**.
2. Library Manager → install **MFRC522**. Everything else is built into the ESP32 core.

## 3. Create your settings file

Copy `secrets.h.example` to `secrets.h` (same folder) and fill it in:

```cpp
#define MY_WIFI_SSID       "YOUR_WIFI_NAME"
#define MY_WIFI_PASS       "YOUR_WIFI_PASSWORD"
#define MY_API_KEY         "YOUR_FIREBASE_WEB_API_KEY"     // same as FIREBASE_API_KEY in web/.env
#define MY_PROJECT_ID      "your-firebase-project-id"      // same as FIREBASE_PROJECT_ID in web/.env
#define MY_DEVICE_NAME     "Main Gate"                     // shown in Devices (max 40 chars)
#define MY_GMT_OFFSET      19800                           // India +5:30
```

| Timezone | `MY_GMT_OFFSET` |
|---|---|
| India (IST +5:30) | 19800 |
| Dubai (+4:00) | 14400 |
| London (+0:00) | 0 |
| Singapore (+8:00) | 28800 |
| US Eastern (-5:00) | -18000 |

Use the office timezone: the reader stamps the date and time with it, and the dashboard uses the browser's local date.

## 4. Turn on Anonymous sign-in (once)

Firebase Console → **Authentication → Sign-in method → Anonymous → Enable**. Without it the reader prints
`Turn on 'Anonymous' in Firebase console...` and cannot register.

## 5. Upload

Plug the ESP32 in, choose the port, **Upload** (hold **BOOT** if it fails), open **Serial Monitor at 115200**. First boot:

```
WiFi OK: 192.168.1.105
Internet test: OK
Time: 2026-09-21 09:30:45
NEW READER registered. ID: Xk3f...
-> A Super Admin must click APPROVE for it in the web dashboard (Devices).
READY - Scan a card!
```

## 6. Approve it in the web dashboard

Open the dashboard as Super Admin → **Devices**. The reader is listed as **Pending** under the name you set. Click **Approve**.
Now tap a card:

```
Card: 82510704
Employee found
CHECK IN: 82510704 at 09:31:02
```

Tap the same card later for **CHECK OUT**. A third tap says `ALREADY DONE`.

Until it is approved (or after **Revoke**) a tap prints `NOT APPROVED ...` and blinks twice slowly. Nothing is written.

How the sign-in works: the reader keeps a long-lived refresh token in its own flash memory (never in the source code), trades it for a 1-hour access token, and refreshes it automatically. If the token ever becomes invalid it registers again as a new *Pending* reader. Lost or replaced a chip? **Revoke / Remove** it in Devices.

## 7. Run without a laptop

Unplug from the laptop and power it from any 5 V USB adapter near the entrance. It reconnects to WiFi and resumes on its own.

## LED guide

| LED | Meaning |
|---|---|
| Blinking slowly | Connecting to WiFi |
| Solid on | Ready, waiting for a card |
| 3 quick blinks (boot) | Ready |
| 1 blink | CHECK IN |
| 2 quick blinks | CHECK OUT |
| 3 slow blinks | Already checked in and out today |
| 2 long blinks | **Reader not approved** (or revoked) - approve it in Devices |
| 5 rapid blinks | Error: unknown card, network problem, or write failed |

## Troubleshooting

| Problem | Fix |
|---|---|
| Won't connect to WiFi | Check SSID / password; it must be 2.4 GHz |
| `Anonymous sign-in failed` / `Turn on 'Anonymous'` | Step 4; also check `MY_API_KEY` and `MY_PROJECT_ID` |
| Not listed in Devices | Web rules not deployed (`firebase deploy --only firestore:rules` in `web/`) or no internet |
| `NOT APPROVED` | Click **Approve** in Devices |
| `UNKNOWN CARD` | The card UID is not registered under an employee |
| `Employee lookup failed, HTTP 401` | Token expired - it re-signs-in on the next tap |
| Wrong times | Fix `MY_GMT_OFFSET` |
| `secrets.h: No such file` | Step 3 |
| `MFRC522.h: No such file` | Install the MFRC522 library |
| Upload fails | Hold BOOT while uploading |
| Garbage in Serial Monitor | Set 115200 baud |
| Card not detected | Hold it 2-3 cm from the reader coil; recheck wiring and 3.3 V |
