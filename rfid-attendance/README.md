# RFID Employee Attendance System

A complete web-based employee attendance system using ESP32 + RC522 RFID reader with a modern web dashboard, powered by Google Apps Script and Google Sheets as the backend.

## Project Architecture

```
Employee scans RFID card
        |
        v
ESP32 reads UID via RC522
        |
        v
ESP32 sends HTTP POST to Google Apps Script
        |
        v
Google Apps Script processes request
        |
        v
Data stored in Google Sheets
        |
        v
Web Dashboard fetches data via API
        |
        v
Dashboard auto-refreshes every 5 seconds
```

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Microcontroller | ESP32 DevKit V1 |
| RFID Reader | RC522 (MFRC522) |
| Backend API | Google Apps Script |
| Database | Google Sheets |
| Frontend | HTML5, CSS3, Bootstrap 5, Vanilla JS |
| Charts | Chart.js |
| Icons | Font Awesome 6 |
| Hosting | Netlify (static frontend) |

## Folder Structure

```
rfid-attendance/
  arduino/
    esp32_attendance.ino       # ESP32 firmware
  web/
    index.html                 # Entry point (redirects)
    login.html                 # Admin login page
    dashboard.html             # Main dashboard with stats & charts
    employees.html             # Employee management (CRUD)
    attendance.html            # Attendance records & filters
    rfid-register.html         # RFID card registration
    reports.html               # Report generation & export
    assets/
      css/
        style.css              # Complete stylesheet (dark/light mode)
      js/
        app.js                 # Core JS (API, Auth, Utils, Toast, Theme)
      images/                  # Image assets
  google-app-script/
    Code.gs                    # Complete Google Apps Script backend
  README.md                    # This file
```

## Hardware Wiring

### RC522 to ESP32 Connections

```
RC522 Pin    ESP32 Pin
---------    ---------
SDA    ----> GPIO 5
SCK    ----> GPIO 18
MOSI   ----> GPIO 23
MISO   ----> GPIO 19
RST    ----> GPIO 22
3.3V   ----> 3.3V
GND    ----> GND
```

### LED Indicators (Optional)

```
Green LED  ----> GPIO 2 (Built-in LED on most ESP32 boards)
Red LED    ----> GPIO 4 (with 220 ohm resistor)
Buzzer     ----> GPIO 15 (optional)
```

### Wiring Diagram

```
    ESP32 DevKit V1              RC522 RFID Reader
    +-----------+                +-------------+
    |           |                |             |
    |  GPIO 5  |----SDA-------->|  SDA        |
    |  GPIO 18 |----SCK-------->|  SCK        |
    |  GPIO 23 |----MOSI------->|  MOSI       |
    |  GPIO 19 |<---MISO--------|  MISO       |
    |  GPIO 22 |----RST-------->|  RST        |
    |  3.3V    |----3.3V------->|  3.3V       |
    |  GND     |----GND-------->|  GND        |
    |           |                |             |
    +-----------+                +-------------+
```

**IMPORTANT: Connect to 3.3V, NOT 5V. The RC522 operates at 3.3V.**

## Setup Instructions

### Step 1: Google Sheets Setup

1. Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet
2. Name it "RFID Attendance System"
3. The setup function will create all required sheets automatically (see Step 2)

### Step 2: Google Apps Script Setup

1. In your Google Sheet, go to **Extensions > Apps Script**
2. Delete any existing code in `Code.gs`
3. Copy and paste the entire contents of `google-app-script/Code.gs`
4. Click **Save** (Ctrl+S)
5. Run the `setupSpreadsheet` function:
   - Select `setupSpreadsheet` from the function dropdown at the top
   - Click the **Run** button (play icon)
   - Grant the required permissions when prompted
   - This creates all sheets, headers, sample data, and settings
6. Deploy as Web App:
   - Click **Deploy > New deployment**
   - Click the gear icon, select **Web app**
   - Set **Execute as**: Me
   - Set **Who has access**: Anyone
   - Click **Deploy**
   - **Copy the Web App URL** - you'll need this for both ESP32 and the web dashboard

### Step 3: ESP32 Arduino Setup

1. **Install Arduino IDE** from [arduino.cc](https://www.arduino.cc/en/software)

2. **Add ESP32 Board Package**:
   - Go to File > Preferences
   - In "Additional Board Manager URLs", add:
     ```
     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
     ```
   - Go to Tools > Board > Board Manager
   - Search "ESP32" and install **ESP32 by Espressif Systems**

3. **Install Required Libraries**:
   - Go to Sketch > Include Library > Manage Libraries
   - Search and install:
     - **MFRC522** by GithubCommunity
     - **ArduinoJson** by Benoit Blanchon (version 6.x)

4. **Configure the Firmware**:
   - Open `arduino/esp32_attendance.ino`
   - Update these lines with your values:
     ```cpp
     const char* WIFI_SSID = "YOUR_WIFI_SSID";
     const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
     const char* SERVER_URL = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec";
     ```

5. **Upload to ESP32**:
   - Connect ESP32 via USB
   - Select Board: **ESP32 Dev Module**
   - Select the correct COM port
   - Click Upload
   - Open Serial Monitor (115200 baud) to see output

### Step 4: Web Dashboard Setup

1. **Configure API URL**:
   - Open `web/assets/js/app.js`
   - Update the `SCRIPT_URL` with your Google Apps Script Web App URL:
     ```javascript
     SCRIPT_URL: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"
     ```

2. **Test Locally**:
   - Open `web/login.html` in a browser
   - Login with default credentials:
     - Email: `admin@company.com`
     - Password: `admin123`

### Step 5: Deploy to Netlify

1. Go to [Netlify](https://www.netlify.com) and sign up/login
2. Click **Add new site > Deploy manually**
3. Drag and drop the entire `web/` folder
4. Your site will be live with a Netlify URL
5. (Optional) Set up a custom domain in Site Settings

## Features

### Dashboard
- Real-time statistics (Total Employees, Present, Absent, Late, Check-ins, Check-outs)
- Animated counter cards
- Weekly attendance bar chart
- Department-wise doughnut chart
- Today's activity table
- Auto-refresh every 5 seconds

### Employee Management
- Add, Edit, Delete (deactivate) employees
- Search and filter by name, ID, department
- Employee photo support
- RFID UID display
- Pagination

### Attendance Module
- Automatic Check In / Check Out logic
- First scan = Check In
- Second scan = Check Out
- Third scan = Ignored
- Attendance rules: Before 9:15 AM = Present, After 9:15 AM = Late
- Real-time updates

### RFID Registration
- Scan RFID card to detect UID
- Auto-polling for last scanned UID
- Manual UID entry option
- Duplicate prevention
- Registered cards overview table

### Reports
- Daily, Weekly, Monthly, Employee reports
- Interactive charts
- Export to CSV, Excel, PDF
- Print functionality
- Filter by date, department, employee

### UI/UX
- Modern glassmorphism design
- Dark mode / Light mode toggle
- Responsive design (mobile-friendly)
- Sidebar navigation
- Toast notifications
- Loading animations
- Gradient stat cards
- Search and filters
- Pagination

## API Documentation

### GET Endpoints

| Action | Parameters | Description |
|--------|-----------|-------------|
| `getDashboardStats` | none | Get all dashboard statistics |
| `getEmployees` | none | Get all employees |
| `getEmployee` | `id` | Get single employee |
| `getAttendance` | `date`, `employeeId`, `department`, `startDate`, `endDate` | Get attendance records |
| `getLastUID` | none | Get last scanned RFID UID |
| `login` | `email`, `password` | Authenticate admin |
| `getSettings` | none | Get system settings |

### POST Endpoints

| Action | Body Fields | Description |
|--------|------------|-------------|
| `scan` | `rfid_uid`, `device`, `ip` | Process RFID scan |
| `addEmployee` | Employee fields | Add new employee |
| `updateEmployee` | Employee fields | Update employee |
| `deleteEmployee` | `employeeId` | Deactivate employee |
| `registerRFID` | `employeeId`, `rfidUID` | Register RFID card |
| `login` | `email`, `password` | Authenticate admin |

### Response Format

All API responses follow this format:
```json
{
  "status": "success" | "error",
  "message": "Description",
  "data": { ... }
}
```

## Google Sheets Structure

### Employees Sheet

| Column | Field |
|--------|-------|
| A | Employee ID |
| B | Employee Name |
| C | RFID UID |
| D | Department |
| E | Designation |
| F | Email |
| G | Phone |
| H | Joining Date |
| I | Photo URL |
| J | Status |

### Attendance Sheet

| Column | Field |
|--------|-------|
| A | Employee ID |
| B | Employee Name |
| C | RFID UID |
| D | Date |
| E | Check In |
| F | Check Out |
| G | Working Hours |
| H | Status |
| I | Device |
| J | IP Address |

### Settings Sheet

| Key | Default Value |
|-----|--------------|
| office_start | 09:00 |
| late_after | 09:15 |
| admin_email | admin@company.com |
| admin_password | admin123 |
| company_name | TechCorp Solutions |

## Default Credentials

| Field | Value |
|-------|-------|
| Email | admin@company.com |
| Password | admin123 |

**Change these in the Settings sheet after first login.**

## Sample Data

The `setupSpreadsheet()` function creates 5 sample employees and attendance records:

| ID | Name | Department | RFID UID |
|----|------|-----------|----------|
| EMP001 | John Smith | Engineering | A1 B2 C3 D4 |
| EMP002 | Sarah Johnson | Marketing | E5 F6 G7 H8 |
| EMP003 | Mike Wilson | HR | I9 J0 K1 L2 |
| EMP004 | Emily Davis | Engineering | M3 N4 O5 P6 |
| EMP005 | Robert Brown | Finance | Q7 R8 S9 T0 |

## Attendance Rules

| Condition | Status |
|-----------|--------|
| Check in before 9:15 AM | Present |
| Check in after 9:15 AM | Late |
| No scan | Absent |
| First scan of day | Check In |
| Second scan of day | Check Out |
| Third+ scan of day | Ignored |

## Troubleshooting

### ESP32 Issues

| Problem | Solution |
|---------|----------|
| "MFRC522 Firmware Version: 0x00" | Check wiring, ensure SDA is on GPIO 5 |
| WiFi won't connect | Verify SSID/password, ensure 2.4GHz network |
| HTTP request fails | Check Google Apps Script URL, ensure deployment is set to "Anyone" |
| Card not reading | Ensure card is within 2-3cm of reader |
| Upload fails | Hold BOOT button on ESP32 during upload |

### Google Apps Script Issues

| Problem | Solution |
|---------|----------|
| Permission denied | Re-run setupSpreadsheet and grant permissions |
| CORS errors | Ensure deployment access is set to "Anyone" |
| Data not saving | Check sheet names match exactly: "Employees", "Attendance", "Settings" |
| Wrong timezone | Update timezone in Apps Script: File > Project Settings |

### Web Dashboard Issues

| Problem | Solution |
|---------|----------|
| Login not working | Verify SCRIPT_URL in app.js, check Settings sheet credentials |
| Data not loading | Check browser console for errors, verify API URL |
| Charts not showing | Ensure Chart.js CDN is loading |
| Styles broken | Clear browser cache, check CSS file path |

## Security Notes

- Change default admin credentials after setup
- The Google Apps Script URL acts as an API key - keep it private
- Session authentication uses sessionStorage (cleared on browser close)
- All inputs are validated on both client and server side
- RFID UIDs are checked for duplicates before registration
- Employee deletion is soft-delete (status set to Inactive)

## Future Improvements

- Multi-device support with device management
- Employee self-service portal
- Email notifications for late arrivals
- Overtime tracking
- Leave management integration
- Biometric integration
- Mobile app (React Native)
- QR code backup scanning
- Geofencing for location verification
- Advanced analytics and AI predictions
- Shift management
- Firebase real-time sync option
- Two-factor authentication
- Bulk employee import via CSV
- Webhook notifications (Slack, Teams)

## License

This project is open source and available for educational and commercial use.

## Credits

Built with:
- [ESP32](https://www.espressif.com/en/products/socs/esp32)
- [MFRC522 Library](https://github.com/miguelbalboa/rfid)
- [Bootstrap 5](https://getbootstrap.com/)
- [Chart.js](https://www.chartjs.org/)
- [Font Awesome](https://fontawesome.com/)
- [Google Apps Script](https://developers.google.com/apps-script)
