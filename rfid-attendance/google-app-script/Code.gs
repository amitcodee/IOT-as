/**
 * RFID Attendance - Simple Test Version
 *
 * SETUP:
 * 1. Create a new Google Sheet
 * 2. Extensions > Apps Script > paste this code
 * 3. Run setupSheet() once
 * 4. Deploy > New deployment > Web app > Anyone > Deploy
 * 5. Copy the URL
 *
 * TEST:
 * Open in browser: YOUR_URL?action=test
 * You should see: {"status":"success","message":"API is working"}
 */

function doGet(e) {
  var action = e.parameter.action;
  var result;

  if (action === "test") {
    result = { status: "success", message: "API is working" };

  } else if (action === "getAttendance") {
    result = getAllAttendance();

  } else if (action === "getEmployees") {
    result = getAllEmployees();

  } else {
    result = { status: "error", message: "Unknown action. Try ?action=test" };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var result;

  try {
    var data = JSON.parse(e.postData.contents);

    if (data.action === "scan") {
      result = handleScan(data.rfid_uid, data.device || "Unknown", data.ip || "N/A");
    } else {
      result = { status: "error", message: "Unknown action" };
    }
  } catch (err) {
    result = { status: "error", message: err.toString() };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Handle RFID scan
 * 1st scan today = Check In
 * 2nd scan today = Check Out
 * 3rd scan today = Ignore
 */
function handleScan(uid, device, ip) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var empSheet = ss.getSheetByName("Employees");
  var attSheet = ss.getSheetByName("Attendance");

  // Find employee by RFID UID
  var empData = empSheet.getDataRange().getValues();
  var employee = null;

  for (var i = 1; i < empData.length; i++) {
    if (empData[i][2] === uid) {
      employee = { id: empData[i][0], name: empData[i][1], department: empData[i][3] };
      break;
    }
  }

  if (!employee) {
    return { status: "error", message: "Card not registered", uid: uid };
  }

  // Check today's record
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
  var attData = attSheet.getDataRange().getValues();
  var existingRow = -1;
  var hasCheckOut = false;

  for (var i = 1; i < attData.length; i++) {
    var recDate = attData[i][3];
    if (recDate instanceof Date) {
      recDate = Utilities.formatDate(recDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
    }
    if (attData[i][0] === employee.id && recDate === today) {
      existingRow = i + 1;
      hasCheckOut = attData[i][5] !== "";
      break;
    }
  }

  // 1st scan = Check In
  if (existingRow === -1) {
    var status = isLate(now) ? "Late" : "Present";
    attSheet.appendRow([employee.id, employee.name, uid, today, now, "", "", status, device, ip]);

    return {
      status: "success",
      type: "CHECK_IN",
      employee: employee.name,
      time: now,
      attendance: status
    };
  }

  // 2nd scan = Check Out
  if (!hasCheckOut) {
    var checkIn = attData[existingRow - 1][4];
    var hours = calcHours(checkIn, now);
    attSheet.getRange(existingRow, 6).setValue(now);
    attSheet.getRange(existingRow, 7).setValue(hours);

    return {
      status: "success",
      type: "CHECK_OUT",
      employee: employee.name,
      time: now,
      workingHours: hours
    };
  }

  // 3rd scan = Ignore
  return {
    status: "info",
    type: "ALREADY_DONE",
    employee: employee.name,
    message: "Already checked in and out today"
  };
}

function getAllAttendance() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Attendance");
  var data = sheet.getDataRange().getValues();
  var records = [];

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "") continue;
    var d = data[i][3];
    if (d instanceof Date) d = Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");

    records.push({
      employeeId: data[i][0],
      name: data[i][1],
      uid: data[i][2],
      date: d,
      checkIn: data[i][4],
      checkOut: data[i][5],
      hours: data[i][6],
      status: data[i][7],
      device: data[i][8],
      ip: data[i][9]
    });
  }

  return { status: "success", count: records.length, data: records };
}

function getAllEmployees() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Employees");
  var data = sheet.getDataRange().getValues();
  var employees = [];

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "") continue;
    employees.push({
      id: data[i][0],
      name: data[i][1],
      rfidUID: data[i][2],
      department: data[i][3]
    });
  }

  return { status: "success", count: employees.length, data: employees };
}

function isLate(timeStr) {
  var parts = timeStr.split(":");
  var mins = parseInt(parts[0]) * 60 + parseInt(parts[1]);
  return mins > 555; // 9:15 AM
}

function calcHours(checkIn, checkOut) {
  var inP = checkIn.split(":");
  var outP = checkOut.split(":");
  var diff = (parseInt(outP[0]) * 60 + parseInt(outP[1])) - (parseInt(inP[0]) * 60 + parseInt(inP[1]));
  if (diff < 0) diff += 1440;
  return Math.floor(diff / 60) + "h " + (diff % 60) + "m";
}

/**
 * RUN THIS ONCE to create sheets and sample data
 */
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Employees sheet
  var emp = ss.getSheetByName("Employees") || ss.insertSheet("Employees");
  emp.clear();
  emp.appendRow(["Employee ID", "Employee Name", "RFID UID", "Department"]);
  emp.appendRow(["EMP001", "John Smith", "A1 B2 C3 D4", "Engineering"]);
  emp.appendRow(["EMP002", "Sarah Johnson", "E5 F6 G7 H8", "Marketing"]);
  emp.appendRow(["EMP003", "Mike Wilson", "I9 J0 K1 L2", "HR"]);
  emp.getRange(1, 1, 1, 4).setFontWeight("bold").setBackground("#4285f4").setFontColor("#fff");

  // Attendance sheet
  var att = ss.getSheetByName("Attendance") || ss.insertSheet("Attendance");
  att.clear();
  att.appendRow(["Employee ID", "Employee Name", "RFID UID", "Date", "Check In", "Check Out", "Working Hours", "Status", "Device", "IP"]);
  att.getRange(1, 1, 1, 10).setFontWeight("bold").setBackground("#4285f4").setFontColor("#fff");

  // Remove default Sheet1
  var s1 = ss.getSheetByName("Sheet1");
  if (s1 && ss.getNumSheets() > 1) ss.deleteSheet(s1);

  SpreadsheetApp.getUi().alert("Done! Sheets created with 3 sample employees.");
}
