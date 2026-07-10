# How to Run - RFID Employee Attendance System

Complete step-by-step guide to get the system running from scratch.

---

## PART 1: Google Sheets + Apps Script (Backend)

### Step 1: Create Google Sheet

1. Open your browser and go to https://sheets.google.com
2. Click **Blank spreadsheet** to create a new one
3. Name it **RFID Attendance System** (click "Untitled spreadsheet" at top-left to rename)

### Step 2: Open Apps Script Editor

1. In your Google Sheet, click **Extensions** in the top menu
2. Click **Apps Script**
3. A new tab will open with the Apps Script editor

### Step 3: Paste the Backend Code

1. In the Apps Script editor, you will see a file called `Code.gs` with some default code
2. **Select all** the default code and **delete** it
3. Open the file `google-app-script/Code.gs` from this project
4. **Copy the entire contents** and **paste** it into the Apps Script editor
5. Press **Ctrl + S** to save

### Step 4: Run the Setup Function

This creates all sheets, headers, sample employees, and sample attendance data.

1. In the Apps Script editor, look at the top toolbar
2. You will see a dropdown that says `setupSpreadsheet` (if not, click the dropdown and select it)
3. Click the **Run** button (the play/triangle icon)
4. A popup will say **Authorization required** - click **Review Permissions**
5. Select your Google account
6. You may see a warning "Google hasn't verified this app" - click **Advanced** then **Go to RFID Attendance System (unsafe)**
7. Click **Allow**
8. Wait for the function to finish - you will see a popup saying **Setup complete!**
9. Go back to your Google Sheet tab - you should now see three sheets at the bottom:
   - **Employees** (with 5 sample employees)
   - **Attendance** (with sample attendance records)
   - **Settings** (with admin credentials and office timings)

### Step 5: Deploy as Web App

1. Go back to the Apps Script editor tab
2. Click **Deploy** in the top menu
3. Click **New deployment**
4. Click the **gear icon** next to "Select type" and choose **Web app**
5. Fill in:
   - **Description**: RFID Attendance API
   - **Execute as**: **Me** (your email)
   - **Who has access**: **Anyone**
6. Click **Deploy**
7. You will see a **Web app URL** that looks like:
   ```
   https://script.google.com/macros/s/AKfycbx.../exec
   ```
8. **COPY THIS URL** and save it somewhere - you need it for both ESP32 and the web dashboard

> **IMPORTANT**: Every time you edit Code.gs, you must create a **New deployment** for changes to take effect. Or go to Deploy > Manage deployments > Edit > Version: New version > Deploy.

---

## PART 2: Web Dashboard (Frontend)

### Step 6: Configure the API URL

1. Open the file `web/assets/js/app.js` in any text editor (Notepad, VS Code, etc.)
2. Find this line near the top (line 15):
   ```javascript
   SCRIPT_URL: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
   ```
3. Replace `YOUR_DEPLOYMENT_ID` with the URL you copied in Step 5
4. The line should now look like:
   ```javascript
   SCRIPT_URL: "https://script.google.com/macros/s/AKfycbx.../exec",
   ```
5. Save the file

### Step 7: Test Locally

1. Open the file `web/login.html` in your browser (double-click it or right-click > Open with > Chrome)
2. Login with:
   - **Email**: `admin@company.com`
   - **Password**: `admin123`
3. You should see the Dashboard with sample data loaded

> **If login fails**: Open browser DevTools (F12 > Console tab) and check for errors. Common issue is incorrect API URL.

### Step 8: Deploy to Netlify (Make it Live)

#### Option A: Drag and Drop (Easiest)

1. Go to https://www.netlify.com and sign up (free) or log in
2. After login, go to https://app.netlify.com/drop
3. Open your file explorer and navigate to the `web/` folder
4. **Drag the entire `web/` folder** and drop it on the Netlify page
5. Wait for deployment to finish (takes about 30 seconds)
6. Netlify gives you a live URL like `https://random-name-12345.netlify.app`
7. Open that URL in your browser - your attendance system is now live

#### Option B: Netlify CLI

1. Install Node.js from https://nodejs.org
2. Open terminal/command prompt and run:
   ```bash
   npm install -g netlify-cli
   netlify login
   cd path/to/rfid-attendance/web
   netlify deploy --prod --dir .
   ```
3. Follow the prompts to create a new site

---

## PART 3: ESP32 Hardware (Optional - for actual RFID scanning)

> **Skip this part if you just want to test the web dashboard.** The dashboard works with sample data even without hardware.

### Step 9: Install Arduino IDE

1. Download Arduino IDE from https://www.arduino.cc/en/software
2. Install it on your computer

### Step 10: Add ESP32 Board Support

1. Open Arduino IDE
2. Go to **File > Preferences**
3. In the **Additional Board Manager URLs** field, paste:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
4. Click **OK**
5. Go to **Tools > Board > Board Manager**
6. Search for **ESP32**
7. Find **ESP32 by Espressif Systems** and click **Install**
8. Wait for installation to complete

### Step 11: Install Libraries

1. In Arduino IDE, go to **Sketch > Include Library > Manage Libraries**
2. Search for **MFRC522** - install the one by **GithubCommunity**
3. Search for **ArduinoJson** - install **version 6.x** by Benoit Blanchon

### Step 12: Wire the RC522 to ESP32

Connect the wires as follows:

```
RC522 Pin     ESP32 Pin
---------     ---------
SDA      ---> GPIO 5
SCK      ---> GPIO 18
MOSI     ---> GPIO 23
MISO     ---> GPIO 19
RST      ---> GPIO 22
3.3V     ---> 3.3V (NOT 5V!)
GND      ---> GND
```

### Step 13: Configure and Upload Firmware

1. Open `arduino/esp32_attendance.ino` in Arduino IDE
2. Change these three lines at the top:
   ```cpp
   const char* WIFI_SSID = "YOUR_WIFI_SSID";         // Your WiFi name
   const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";   // Your WiFi password
   const char* SERVER_URL = "https://script.google.com/macros/s/AKfycbx.../exec";  // Your Apps Script URL
   ```
3. Connect ESP32 to your computer via USB cable
4. In Arduino IDE:
   - Go to **Tools > Board** and select **ESP32 Dev Module**
   - Go to **Tools > Port** and select the COM port (e.g., COM3, COM4)
5. Click the **Upload** button (right arrow icon)
6. If upload fails, **hold the BOOT button** on the ESP32 while uploading

### Step 14: Test the Hardware

1. After upload completes, open **Tools > Serial Monitor**
2. Set baud rate to **115200** (dropdown at bottom-right)
3. You should see:
   ```
   ============================================================
      RFID Employee Attendance System - Starting Up
   ============================================================
   [OK] SPI bus initialized
   [OK] RFID reader initialized
   [WiFi] Connected successfully!
   [WiFi] IP Address: 192.168.x.x
   ============================================================
      System Ready - Please scan your RFID card
   ============================================================
   ```
4. Hold an RFID card near the reader
5. You should see the UID printed and attendance data sent to Google Sheets

---

## Quick Test Checklist

After setup, verify everything works:

- [ ] Google Sheet has 3 tabs: Employees, Attendance, Settings
- [ ] Sample employees appear in Employees sheet (5 rows)
- [ ] Web login page loads without errors
- [ ] Login works with `admin@company.com` / `admin123`
- [ ] Dashboard shows stat cards with numbers
- [ ] Dashboard charts render
- [ ] Employees page lists sample employees
- [ ] Attendance page shows sample records
- [ ] (Hardware) Serial Monitor shows "System Ready"
- [ ] (Hardware) Scanning a card shows UID in Serial Monitor

---

## Changing Default Settings

### Change Admin Password

1. Open your Google Sheet
2. Go to the **Settings** tab
3. Change the value in row 4, column B from `admin123` to your new password

### Change Office Timings

1. Go to the **Settings** tab
2. Row 1 column B: Office start time (default: `09:00`)
3. Row 2 column B: Late threshold (default: `09:15`)

### Change Company Name

1. Go to the **Settings** tab
2. Row 5 column B: Change `TechCorp Solutions` to your company name

---

## Common Problems and Fixes

| Problem | Fix |
|---------|-----|
| Login says "Connection failed" | Check that the SCRIPT_URL in `app.js` is correct and the Apps Script is deployed |
| Dashboard shows all zeros | The API URL might be wrong, or the Apps Script needs redeployment |
| "Google hasn't verified this app" | Click Advanced > Go to app (unsafe) - this is normal for personal scripts |
| ESP32 won't connect to WiFi | Make sure your WiFi is 2.4GHz (ESP32 does not support 5GHz) |
| RFID reader not detecting cards | Check wiring, especially SDA (GPIO 5) and RST (GPIO 22) |
| Changes to Code.gs not working | You must create a new deployment version after editing |
| Netlify shows blank page | Make sure you deployed the `web/` folder, not the root `rfid-attendance/` folder |
| CORS error in browser console | Redeploy Apps Script with access set to "Anyone" |
