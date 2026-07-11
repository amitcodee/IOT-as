# How to Run - RFID Attendance System

---

## HARDWARE YOU NEED

- ESP32 DevKit V1
- RC522 RFID Reader Module
- RFID Cards or Tags
- Jumper Wires (7 wires)
- USB Cable (micro USB or USB-C depending on your ESP32)

---

## STEP 1: WIRE THE RC522 TO ESP32

Connect these 7 wires:

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

WARNING: Use 3.3V NOT 5V. The RC522 runs on 3.3V.

---

## STEP 2: UPLOAD CODE TO ESP32

1. Download and install Arduino IDE from https://www.arduino.cc/en/software

2. Open Arduino IDE. Go to File > Preferences.
   In "Additional Board Manager URLs" paste this:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
   Click OK.

3. Go to Tools > Board > Board Manager.
   Search "ESP32". Install "ESP32 by Espressif Systems".

4. Go to Sketch > Include Library > Manage Libraries.
   Search "MFRC522". Install it.

5. Open the file: `arduino/rfid_scanner.ino`

6. Plug ESP32 into your computer with USB cable.

7. In Arduino IDE:
   - Tools > Board > select "ESP32 Dev Module"
   - Tools > Port > select the COM port that appeared (like COM3 or COM4)

8. Click Upload button (arrow icon).
   If it fails, hold the BOOT button on ESP32 while uploading.

9. After upload is done, open Tools > Serial Monitor.
   Set baud rate to 115200.
   You should see: `RFID_READY`

10. Hold an RFID card near the RC522 reader.
    You should see: `UID:XXXXXXXX` in Serial Monitor.
    This means hardware is working. Close Serial Monitor.

---

## STEP 3: CONFIGURE THE WEB APP

1. Copy `.env.example` to `.env`.
2. Fill in your Firebase web config values in `.env`.
3. Make sure Firebase Email/Password sign-in is enabled in the Firebase console.
4. Create at least one Firebase Auth user for logging in.

---

## STEP 4: START THE DASHBOARD

Run the local server from the workspace root or from the `rfid-attendance` folder:

```bash
npm start
```

If you are already inside `rfid-attendance`, this also works:

```bash
node server.mjs
```

Then open:

```text
http://localhost:3000
```

The login screen appears first. After sign-in, you will see:

1. Dashboard with metrics and today attendance.
2. Employees with add, view, edit, and delete actions.
3. Attendance with full date-based history.
4. Settings with the active `.env` project info.

---

## STEP 5: CONNECT THE ESP32 READER

1. In the Dashboard section, click `Connect`.
2. Pick the ESP32 COM port.
3. Hold a card near the reader.
4. The live output panel updates with check-in and check-out JSON.

The scanner works in Chrome or Edge on localhost because it uses the Web Serial API.

---

## STEP 6: PYTHON IS TEMPORARY

The `test.py` script is still in the project for now as a fallback bridge, but the browser app is the main path.

If you want to keep using the Python terminal tool for the moment, it still supports manual mode and serial reading. You can remove it later once the browser flow is fully verified.

---

## HOW THE SCAN LOGIC WORKS

```
Card taps reader
      |
      v
ESP32 reads UID from card
      |
      v
ESP32 sends "UID:A1B2C3D4" over USB serial
      |
      v
Browser reads it from the Web Serial API
      |
      v
Dashboard checks: is this UID registered?
      |
  NO -+-> Shows "UNKNOWN CARD" JSON
      |
  YES-+-> First scan today?
           |
       YES-+-> CHECK IN (shows employee name, time, status)
           |
        NO-+-> Already checked out?
              |
          NO--+-> CHECK OUT (shows working hours)
              |
          YES-+-> ALREADY DONE (ignored)
```

---

## FILES

```
rfid-attendance/
   arduino/
      rfid_scanner.ino   <- Upload this to ESP32
   web/                 <- Login, dashboard, employees, attendance
   server.mjs           <- Local server that reads .env and serves the app
   .env.example         <- Copy to .env and fill in Firebase credentials
   test.py              <- Temporary fallback bridge
   run.md               <- You are reading this
```

---

## TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| Arduino IDE says "No board on COM port" | Try different USB cable. Some cables are charge-only. |
| Upload fails | Hold BOOT button on ESP32 during upload |
| Serial Monitor shows garbage text | Set baud rate to 115200 |
| `RFID_READY` never appears | Check wiring. SDA must be on GPIO 5. |
| Card not detected | Hold card within 2-3cm of the reader coil |
| `pip install pyserial` fails | Try `python -m pip install pyserial` |
| Python says "COM port not found" | Close Arduino Serial Monitor first. Only one program can use the port. |
| Python says "Access denied" on COM port | Close Arduino IDE Serial Monitor. It locks the port. |
