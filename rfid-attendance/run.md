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

## STEP 3: INSTALL PYTHON PACKAGE

Open terminal (cmd) and run:

```
pip install pyserial
```

---

## STEP 4: RUN THE PYTHON SCRIPT

```
cd C:\Users\pandi\OneDrive\Desktop\new\rfid-attendance
python test.py
```

You will see:

```
==================================================
  RFID Attendance System
  Hardware: ESP32 + RC522
==================================================

  [1] Connect to ESP32 (scan real cards)
  [2] Manual mode (type UIDs to test)

  Choose (1 or 2):
```

---

## STEP 5: SCAN CARDS

### Option 1 - Real Hardware

1. Choose `1`
2. It shows available COM ports. Select your ESP32 port number.
3. It says "ESP32 is ready!" and "SCAN A CARD ON THE READER"
4. Hold your RFID card on the RC522 reader
5. JSON appears in terminal:

```json
{
    "status": "success",
    "type": "CHECK_IN",
    "employee": "John Smith",
    "employee_id": "EMP001",
    "department": "Engineering",
    "check_in": "09:05:23",
    "attendance_status": "Present"
}
```

6. Scan same card again = CHECK OUT
7. Scan same card third time = ALREADY DONE
8. Press Ctrl+C to stop

### Option 2 - Manual Mode (No Hardware)

1. Choose `2`
2. Type a UID and press Enter
3. Sample UIDs: `A1B2C3D4`, `E5F6G7H8`, `I9J0K1L2`

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
Python reads it from COM port
      |
      v
Python checks: is this UID registered?
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
  test.py              <- Run this on your computer
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
