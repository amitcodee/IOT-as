const appConfig = window.__APP_CONFIG__ || { appName: "RFID Attendance", firebase: {} };

const sampleEmployees = [
  { uid: "A1B2C3D4", employeeId: "EMP001", name: "John Smith", department: "Engineering", role: "Engineer", phone: "+91 9000000001" },
  { uid: "E5F6G7H8", employeeId: "EMP002", name: "Sarah Johnson", department: "Marketing", role: "Lead", phone: "+91 9000000002" },
  { uid: "I9J0K1L2", employeeId: "EMP003", name: "Mike Wilson", department: "HR", role: "Coordinator", phone: "+91 9000000003" },
];

const state = {
  user: null,
  auth: null,
  db: null,
  employees: [],
  attendance: [],
  selectedEmployeeUid: "",
  employeeSearch: "",
  attendanceSearch: "",
  attendanceFrom: "",
  attendanceTo: "",
  drawerFrom: "",
  drawerTo: "",
  view: "dashboardView",
  serialStatus: "Disconnected",
  syncStatus: "Local demo",
  captureUidForEmployee: false,
  liveOutput: {
    status: "info",
    message: "Sign in to manage attendance",
  },
  scanFeed: [],
  serialPort: null,
  serialReader: null,
  serialDecoder: null,
  serialStreamClosed: null,
  serialConnecting: false,
};

const elements = {};
let employeesUnsub = null;
let attendanceUnsub = null;

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function formatTime(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

function normalizeUid(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isLate(timeString) {
  const [hours, minutes] = timeString.split(":").map(Number);
  return hours * 60 + minutes > 9 * 60 + 15;
}

function calcHours(checkIn, checkOut) {
  const [inHours, inMinutes] = checkIn.split(":").map(Number);
  const [outHours, outMinutes] = checkOut.split(":").map(Number);
  let minutes = outHours * 60 + outMinutes - (inHours * 60 + inMinutes);
  if (minutes < 0) {
    minutes += 24 * 60;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function calcStatus(record) {
  if (!record.checkIn) return "Absent";
  if (record.checkIn && !record.checkOut) return "Present";
  if (record.checkIn && record.checkOut) return "Checked Out";
  return "-";
}

function statusPillClass(status) {
  if (status === "Present") return "info";
  if (status === "Checked Out") return "done";
  if (status === "Absent") return "error";
  return "";
}

function normalizeAttendanceRecord(record) {
  if (!record) {
    return null;
  }

  return {
    dateKey: record.dateKey,
    uid: record.uid,
    employeeId: record.employeeId,
    employeeName: record.employeeName,
    department: record.department,
    role: record.role,
    checkIn: record.checkIn || null,
    checkOut: record.checkOut || null,
  };
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function cacheElements() {
  [
    "loginView",
    "appShell",
    "loginForm",
    "loginEmail",
    "loginPassword",
    "loginHint",
    "topbarTitle",
    "sidebarTitle",
    "currentUserLabel",
    "authStatusPill",
    "syncStatusPill",
    "signOutBtn",
    "signOutBtnSecondary",
    "dashboardView",
    "employeesView",
    "attendanceView",
    "settingsView",
    "metricEmployees",
    "metricPresent",
    "metricCheckedOut",
    "metricLate",
    "connectSerialBtn",
    "disconnectSerialBtn",
    "demoScanBtn",
    "manualUidInput",
    "scanFromInputBtn",
    "serialBadge",
    "syncBadge",
    "serialHint",
    "liveOutput",
    "scanFeed",
    "todayAttendanceBody",
    "employeeForm",
    "employeeUid",
    "employeeId",
    "employeeName",
    "employeeDepartment",
    "employeeRole",
    "employeePhone",
    "connectEmployeeSerialBtn",
    "disconnectEmployeeSerialBtn",
    "employeeSerialStatus",
    "scanEmployeeUidBtn",
    "scanEmployeeUidHint",
    "clearEmployeeFormBtn",
    "employeeSearchInput",
    "employeeTableBody",
    "attendanceFromInput",
    "attendanceToInput",
    "attendanceSearchInput",
    "clearAttendanceFiltersBtn",
    "attendanceTableBody",
    "sampleDataBtn",
    "settingAppName",
    "settingProjectId",
    "drawerBackdrop",
    "employeeDrawer",
    "drawerEmployeeName",
    "drawerSummary",
    "drawerAttendanceBody",
    "drawerFromInput",
    "drawerToInput",
    "drawerClearFiltersBtn",
    "closeDrawerBtn",
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function hasFirebaseConfig() {
  const firebaseConfig = appConfig.firebase || {};
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}

function initFirebase() {
  if (!window.firebase || !hasFirebaseConfig()) {
    state.syncStatus = "Local demo";
    elements.loginHint.textContent = "Set Firebase values in .env and restart the server to enable live auth and Firestore.";
    renderStatusBadges();
    return;
  }

  if (!window.firebase.apps.length) {
    window.firebase.initializeApp(appConfig.firebase);
  }

  state.auth = window.firebase.auth();
  state.db = window.firebase.firestore();
  state.syncStatus = "Firebase live";

  state.auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL).catch(() => null);
  state.auth.onAuthStateChanged(async (user) => {
    state.user = user || null;
    if (user) {
      await loadData();
      showApp();
      renderAll();
    } else {
      showLogin();
    }
  });
}

function showLogin() {
  elements.loginView.classList.remove("hidden");
  elements.appShell.classList.add("hidden");
  elements.loginHint.textContent = hasFirebaseConfig()
    ? "Sign in with your Firebase Auth email and password."
    : "Set Firebase values in .env and restart the server to enable live auth and Firestore.";
}

function showApp() {
  elements.loginView.classList.add("hidden");
  elements.appShell.classList.remove("hidden");
  elements.currentUserLabel.textContent = state.user?.email || "Admin";
  elements.authStatusPill.textContent = state.user?.email || "Signed in";
  elements.settingAppName.textContent = appConfig.appName || "RFID Attendance";
  elements.settingProjectId.textContent = appConfig.firebase?.projectId || "Not configured";
}

function renderStatusBadges() {
  elements.serialBadge.textContent = state.serialStatus;
  elements.syncBadge.textContent = state.syncStatus;
  elements.syncStatusPill.textContent = state.syncStatus;
  elements.serialHint.textContent = state.serialStatus === "Connected" ? "Reader active" : "Waiting for reader";
}

function renderLiveOutput() {
  elements.liveOutput.textContent = formatJson(state.liveOutput || { status: "info", message: "Ready" });
}

function renderUidCaptureState() {
  if (!elements.scanEmployeeUidBtn || !elements.scanEmployeeUidHint) {
    return;
  }

  if (state.captureUidForEmployee) {
    elements.scanEmployeeUidBtn.textContent = "Waiting for scanned UID...";
    elements.scanEmployeeUidBtn.disabled = true;
    elements.scanEmployeeUidHint.textContent = "Tap the RFID card on the reader now.";
    return;
  }

  elements.scanEmployeeUidBtn.textContent = "Scan card to assign UID";
  elements.scanEmployeeUidBtn.disabled = false;
  elements.scanEmployeeUidHint.textContent = "Ready to capture a UID";
}

function renderEmployeeSerialStatus() {
  if (!elements.employeeSerialStatus) {
    return;
  }

  elements.employeeSerialStatus.textContent = state.serialStatus === "Connected" || state.serialStatus === "Reader ready"
    ? `Reader ${state.serialStatus.toLowerCase()}`
    : "Reader disconnected";
}

function setView(viewId) {
  state.view = viewId;
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("is-active", section.id === viewId));
  document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("is-active", button.dataset.view === viewId));
  const labelMap = {
    dashboardView: "Dashboard",
    employeesView: "Employees",
    attendanceView: "Attendance",
    settingsView: "Settings",
  };
  elements.topbarTitle.textContent = labelMap[viewId] || "Dashboard";
  elements.sidebarTitle.textContent = labelMap[viewId] || "Dashboard";
}

function setDefaultLiveOutput() {
  state.liveOutput = {
    status: "info",
    message: "Connect a reader or run a demo scan",
  };
}

function handleFirestoreError(error) {
  const message = error?.message || "Firestore access failed";
  if (String(message).toLowerCase().includes("permission-denied")) {
    state.syncStatus = "Firestore blocked";
    state.liveOutput = {
      status: "error",
      message: "Firestore permission denied. Update Firestore rules to allow the signed-in user.",
    };
    if (elements.loginHint) {
      elements.loginHint.textContent = "Firestore permission denied. Check the Firestore rules in run.md.";
    }
  } else {
    state.liveOutput = {
      status: "error",
      message,
    };
  }

  renderStatusBadges();
  renderLiveOutput();
}

function beginEmployeeUidCapture() {
  state.captureUidForEmployee = true;
  state.liveOutput = {
    status: "info",
    message: "Waiting for a card scan to assign the employee UID",
  };
  renderAll();

  if (state.serialStatus !== "Connected" && !state.serialConnecting) {
    connectSerial();
  }
}

function completeEmployeeUidCapture(uid) {
  elements.employeeUid.value = uid;
  state.captureUidForEmployee = false;
  state.liveOutput = {
    status: "success",
    message: `Captured UID ${uid} for the employee form`,
  };
  renderAll();
  elements.employeeUid.focus();
}

function readEmployees() {
  if (!state.db) {
    state.employees = sampleEmployees.map((employee) => ({ ...employee }));
    return null;
  }

  return state.db.collection("employees").onSnapshot((snapshot) => {
    state.employees = snapshot.docs.map((doc) => ({ uid: doc.id, ...doc.data() })).sort((a, b) => a.name.localeCompare(b.name));
    renderAll();
  }, (error) => {
    handleFirestoreError(error);
  });
}

function readAttendance() {
  if (!state.db) {
    state.attendance = [];
    return null;
  }

  return state.db.collection("attendance").onSnapshot((snapshot) => {
    state.attendance = snapshot.docs
      .map((doc) => normalizeAttendanceRecord(doc.data()))
      .filter(Boolean)
      .sort((a, b) => `${b.dateKey}${b.checkIn || ""}`.localeCompare(`${a.dateKey}${a.checkIn || ""}`));
    renderAll();
  }, (error) => {
    handleFirestoreError(error);
  });
}

async function loadData() {
  if (!state.db) {
    state.employees = sampleEmployees.map((employee) => ({ ...employee }));
    state.attendance = [];
    return;
  }

  if (employeesUnsub) employeesUnsub();
  if (attendanceUnsub) attendanceUnsub();
  employeesUnsub = readEmployees();
  attendanceUnsub = readAttendance();
}

function filterBySearch(items, search, fields) {
  const query = search.trim().toLowerCase();
  if (!query) {
    return items;
  }
  return items.filter((item) => fields.some((field) => String(item[field] || "").toLowerCase().includes(query)));
}

function isWithinDateRange(dateKey, from, to) {
  if (from && dateKey < from) return false;
  if (to && dateKey > to) return false;
  return true;
}

function renderMetrics() {
  const today = todayKey();
  const todayRecords = state.attendance.filter((record) => record.dateKey === today);
  elements.metricEmployees.textContent = state.employees.length;
  elements.metricPresent.textContent = todayRecords.length;
  elements.metricCheckedOut.textContent = todayRecords.filter((record) => Boolean(record.checkOut)).length;
  elements.metricLate.textContent = todayRecords.length;
}

function attendanceRow(record) {
  const hours = record.checkIn && record.checkOut ? calcHours(record.checkIn, record.checkOut) : "-";
  const status = calcStatus(record);
  const pillClass = statusPillClass(status);
  return `
    <tr>
      <td>${record.dateKey || "-"}</td>
      <td>${record.employeeName}</td>
      <td>${record.uid}</td>
      <td>${record.checkIn || "-"}</td>
      <td>${record.checkOut || "-"}</td>
      <td>${hours}</td>
      <td><span class="pill ${pillClass}">${status}</span></td>
    </tr>
  `;
}

function renderTodayAttendance() {
  const today = todayKey();
  const rows = state.attendance
    .filter((record) => record.dateKey === today)
    .map((record) => attendanceRow(record))
    .join("");
  elements.todayAttendanceBody.innerHTML = rows || '<tr><td colspan="7" class="empty-state">No attendance records for today.</td></tr>';
}

function employeeRow(employee) {
  return `
    <tr>
      <td>${employee.uid}</td>
      <td>${employee.employeeId}</td>
      <td>${employee.name}</td>
      <td>${employee.department}</td>
      <td>${employee.role}</td>
      <td>
        <button class="mini-btn" data-view-employee="${employee.uid}" type="button">View</button>
        <button class="mini-btn" data-edit-employee="${employee.uid}" type="button">Edit</button>
        <button class="mini-btn" data-delete-employee="${employee.uid}" type="button">Delete</button>
      </td>
    </tr>
  `;
}

function renderEmployeeTable() {
  const filtered = filterBySearch(state.employees, state.employeeSearch, ["uid", "employeeId", "name", "department", "role"]);
  elements.employeeTableBody.innerHTML = filtered.map((employee) => employeeRow(employee)).join("") || '<tr><td colspan="6" class="empty-state">No employees found.</td></tr>';

  elements.employeeTableBody.querySelectorAll("[data-view-employee]").forEach((button) => {
    button.addEventListener("click", () => openEmployeeDrawer(button.getAttribute("data-view-employee")));
  });

  elements.employeeTableBody.querySelectorAll("[data-edit-employee]").forEach((button) => {
    button.addEventListener("click", () => fillEmployeeForm(button.getAttribute("data-edit-employee")));
  });

  elements.employeeTableBody.querySelectorAll("[data-delete-employee]").forEach((button) => {
    button.addEventListener("click", async () => {
      const uid = button.getAttribute("data-delete-employee");
      if (!uid || !confirm(`Delete employee ${uid}?`)) {
        return;
      }
      await deleteEmployee(uid);
    });
  });
}

function renderAttendanceTable() {
  const filtered = filterBySearch(
    state.attendance.filter((record) => isWithinDateRange(record.dateKey, state.attendanceFrom, state.attendanceTo)),
    state.attendanceSearch,
    ["dateKey", "employeeName", "uid"],
  );

  elements.attendanceTableBody.innerHTML = filtered.map((record) => attendanceRow(record)).join("") || '<tr><td colspan="7" class="empty-state">No attendance records match the filters.</td></tr>';
}

function renderScanFeed() {
  if (!state.scanFeed.length) {
    elements.scanFeed.innerHTML = '<div class="feed-item"><strong>No scan activity yet</strong><span>Connect the ESP32 or run a demo scan to populate the feed.</span></div>';
    return;
  }

  elements.scanFeed.innerHTML = state.scanFeed.slice(0, 6).map((entry) => `
    <div class="feed-item">
      <strong>${entry.name || "Unknown"} <span class="pill ${entry.type === "error" ? "error" : entry.type === "CHECK_OUT" ? "out" : entry.type === "CHECK_IN" ? "info" : "done"}">${entry.type}</span></strong>
      <span>${entry.message}</span>
      <span>${entry.uid || "No UID"} • ${entry.time} • ${entry.source}</span>
    </div>
  `).join("");
}

function renderAll() {
  if (!state.user) {
    return;
  }

  renderStatusBadges();
  renderLiveOutput();
  renderMetrics();
  renderTodayAttendance();
  renderEmployeeTable();
  renderAttendanceTable();
  renderDrawer();
  renderScanFeed();
}

function clearEmployeeForm() {
  elements.employeeForm.reset();
  state.captureUidForEmployee = false;
  renderUidCaptureState();
  elements.employeeUid.focus();
}

function fillEmployeeForm(uid) {
  const employee = state.employees.find((item) => item.uid === uid);
  if (!employee) {
    return;
  }

  elements.employeeUid.value = employee.uid;
  elements.employeeId.value = employee.employeeId || "";
  elements.employeeName.value = employee.name || "";
  elements.employeeDepartment.value = employee.department || "";
  elements.employeeRole.value = employee.role || "";
  elements.employeePhone.value = employee.phone || "";
  setView("employeesView");
}

function openEmployeeDrawer(uid) {
  state.selectedEmployeeUid = uid;
  state.drawerFrom = "";
  state.drawerTo = "";
  elements.drawerFromInput.value = "";
  elements.drawerToInput.value = "";
  renderDrawer();
  elements.employeeDrawer.classList.remove("hidden");
  elements.drawerBackdrop.classList.remove("hidden");
}

function closeEmployeeDrawer() {
  state.selectedEmployeeUid = "";
  elements.employeeDrawer.classList.add("hidden");
  elements.drawerBackdrop.classList.add("hidden");
}

async function saveEmployee(employee) {
  if (!state.db) {
    const existingIndex = state.employees.findIndex((item) => item.uid === employee.uid);
    if (existingIndex >= 0) {
      state.employees[existingIndex] = employee;
    } else {
      state.employees.unshift(employee);
    }
    renderAll();
    return;
  }

  try {
    await state.db.collection("employees").doc(employee.uid).set(employee, { merge: true });
  } catch (error) {
    handleFirestoreError(error);
    throw error;
  }
}

async function deleteEmployee(uid) {
  if (!state.db) {
    state.employees = state.employees.filter((item) => item.uid !== uid);
    state.attendance = state.attendance.filter((item) => item.uid !== uid);
    renderAll();
    return;
  }

  try {
    await state.db.collection("employees").doc(uid).delete();
  } catch (error) {
    handleFirestoreError(error);
    throw error;
  }
}

async function saveAttendance(record) {
  if (!state.db) {
    const key = `${record.dateKey}_${record.uid}`;
    const existingIndex = state.attendance.findIndex((item) => `${item.dateKey}_${item.uid}` === key);
    if (existingIndex >= 0) {
      state.attendance[existingIndex] = normalizeAttendanceRecord(record);
    } else {
      state.attendance.unshift(normalizeAttendanceRecord(record));
    }
    renderAll();
    return;
  }

  const payload = normalizeAttendanceRecord(record);

  try {
    await state.db.collection("attendance").doc(`${record.dateKey}_${record.uid}`).set(payload);
  } catch (error) {
    handleFirestoreError(error);
    throw error;
  }
}

async function getAttendanceRecord(uid, dateKey) {
  const localRecord = state.attendance.find((item) => item.uid === uid && item.dateKey === dateKey);
  if (localRecord || !state.db) {
    return normalizeAttendanceRecord(localRecord);
  }

  let snapshot;
  try {
    snapshot = await state.db.collection("attendance").doc(`${dateKey}_${uid}`).get();
  } catch (error) {
    handleFirestoreError(error);
    return null;
  }
  if (!snapshot.exists) {
    return null;
  }

  return normalizeAttendanceRecord(snapshot.data());
}

async function processScan(rawUid, source = "manual") {
  const uid = normalizeUid(rawUid);
  const now = new Date();
  const time = formatTime(now);
  const dateKey = todayKey(now);

  if (state.captureUidForEmployee) {
    if (uid) {
      completeEmployeeUidCapture(uid);
    }
    return;
  }

  const employee = state.employees.find((item) => item.uid === uid);

  if (!uid) {
    state.liveOutput = { status: "error", message: "UID is required", source, time };
    state.scanFeed.unshift({ uid: "", type: "error", name: "Unknown", message: "UID is required", time, source });
    state.scanFeed = state.scanFeed.slice(0, 8);
    renderAll();
    return;
  }

  if (!employee) {
    state.liveOutput = { status: "error", message: "UNKNOWN CARD", uid, time, source };
    state.scanFeed.unshift({ uid, type: "error", name: "Unknown", message: "UNKNOWN CARD", time, source });
    state.scanFeed = state.scanFeed.slice(0, 8);
    renderAll();
    return;
  }

  let dailyRecord = await getAttendanceRecord(uid, dateKey);

  if (!dailyRecord) {
    dailyRecord = {
      uid,
      employeeId: employee.employeeId,
      employeeName: employee.name,
      department: employee.department,
      role: employee.role,
      dateKey,
      checkIn: time,
      checkOut: null,
    };

    state.liveOutput = {
      status: "success",
      type: "CHECK_IN",
      employee: employee.name,
      employee_id: employee.employeeId,
      department: employee.department,
      check_in: time,
      uid,
    };

    state.scanFeed.unshift({ uid, type: "CHECK_IN", name: employee.name, message: `${employee.name} checked in`, time, source });
    state.scanFeed = state.scanFeed.slice(0, 8);
    state.attendance.unshift(dailyRecord);
    await saveAttendance(dailyRecord);
    renderAll();
    return;
  }

  if (!dailyRecord.checkOut) {
    dailyRecord.checkOut = time;

    state.liveOutput = {
      status: "success",
      type: "CHECK_OUT",
      employee: employee.name,
      employee_id: employee.employeeId,
      check_in: dailyRecord.checkIn,
      check_out: time,
      uid,
    };

    state.scanFeed.unshift({ uid, type: "CHECK_OUT", name: employee.name, message: `${employee.name} checked out`, time, source });
    state.scanFeed = state.scanFeed.slice(0, 8);
    const localIndex = state.attendance.findIndex((item) => item.uid === uid && item.dateKey === dateKey);
    if (localIndex >= 0) {
      state.attendance[localIndex] = dailyRecord;
    } else {
      state.attendance.unshift(dailyRecord);
    }
    await saveAttendance(dailyRecord);
    renderAll();
    return;
  }

  state.liveOutput = {
    status: "info",
    type: "ALREADY_DONE",
    employee: employee.name,
    message: "Already checked in and out today",
    uid,
    time,
  };

  state.scanFeed.unshift({ uid, type: "done", name: employee.name, message: "Already checked in and out today", time, source });
  state.scanFeed = state.scanFeed.slice(0, 8);
  renderAll();
}

function loadSampleData() {
  state.employees = sampleEmployees.map((employee) => ({ ...employee }));
  state.liveOutput = { status: "success", message: "Sample employees loaded" };
  if (state.db) {
    Promise.all(sampleEmployees.map((employee) => state.db.collection("employees").doc(employee.uid).set(employee, { merge: true }))).then(() => renderAll());
  } else {
    renderAll();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  if (!state.auth) {
    elements.loginHint.textContent = "Firebase config is missing. Set .env and restart the local server.";
    return;
  }

  const email = elements.loginEmail.value.trim();
  const password = elements.loginPassword.value;
  try {
    await state.auth.signInWithEmailAndPassword(email, password);
  } catch (error) {
    elements.loginHint.textContent = error.message || "Unable to sign in.";
  }
}

async function handleEmployeeSubmit(event) {
  event.preventDefault();
  const employee = {
    uid: normalizeUid(elements.employeeUid.value),
    employeeId: elements.employeeId.value.trim(),
    name: elements.employeeName.value.trim(),
    department: elements.employeeDepartment.value.trim(),
    role: elements.employeeRole.value.trim(),
    phone: elements.employeePhone.value.trim(),
  };

  if (!employee.uid || !employee.employeeId || !employee.name || !employee.department || !employee.role) {
    alert("Please complete all required employee fields.");
    return;
  }

  await saveEmployee(employee);
  clearEmployeeForm();
  renderAll();
}

async function disconnectSerial() {
  state.serialConnecting = false;

  const port = state.serialPort;
  const reader = state.serialReader;
  const streamClosed = state.serialStreamClosed;

  state.serialPort = null;
  state.serialReader = null;
  state.serialDecoder = null;
  state.serialStreamClosed = null;

  try {
    await reader?.cancel();
  } catch {
    // ignore
  }

  try {
    if (streamClosed) {
      await streamClosed.catch(() => null);
    }
  } catch {
    // ignore
  }

  try {
    reader?.releaseLock();
  } catch {
    // ignore
  }

  try {
    await port?.close();
  } catch {
    // ignore
  }
  state.serialStatus = "Disconnected";
  renderStatusBadges();
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    alert("This browser does not support Web Serial. Use Chrome or Edge.");
    return;
  }

  if (state.serialConnecting || state.serialStatus === "Connected") {
    return;
  }

  state.serialConnecting = true;
  elements.connectSerialBtn.disabled = true;

  try {
    if (state.serialPort || state.serialReader || state.serialDecoder || state.serialStreamClosed) {
      await disconnectSerial();
    }

    state.serialPort = await navigator.serial.requestPort();
    await state.serialPort.open({ baudRate: 115200 });
    state.serialStatus = "Connected";
    renderStatusBadges();

    state.serialDecoder = new TextDecoderStream();
    state.serialStreamClosed = state.serialPort.readable.pipeTo(state.serialDecoder.writable);
    state.serialReader = state.serialDecoder.readable.getReader();
    let buffer = "";

    while (true) {
      const { value, done } = await state.serialReader.read();
      if (done) {
        break;
      }

      buffer += value;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        if (trimmed === "RFID_READY") {
          state.serialStatus = "Reader ready";
          renderStatusBadges();
          continue;
        }

        if (trimmed.startsWith("UID:")) {
          await processScan(trimmed.slice(4), "serial");
        }
      }
    }

    await state.serialStreamClosed?.catch(() => null);
  } catch (error) {
    state.liveOutput = { status: "error", message: error.message || "Unable to connect to the serial reader" };
    renderAll();
  } finally {
    state.serialConnecting = false;
    elements.connectSerialBtn.disabled = false;
    if (elements.connectEmployeeSerialBtn) {
      elements.connectEmployeeSerialBtn.disabled = false;
    }
  }
}

function renderDrawer() {
  const employee = state.employees.find((item) => item.uid === state.selectedEmployeeUid);
  if (!employee) {
    elements.drawerEmployeeName.textContent = "Select an employee";
    elements.drawerSummary.innerHTML = '<div class="empty-state">Choose an employee to view the full attendance history.</div>';
    elements.drawerAttendanceBody.innerHTML = '<tr><td colspan="5" class="empty-state">No employee selected.</td></tr>';
    return;
  }

  elements.drawerEmployeeName.textContent = employee.name;
  elements.drawerSummary.innerHTML = `
    <div class="setting-card"><span>UID</span><strong>${employee.uid}</strong></div>
    <div class="setting-card"><span>Employee ID</span><strong>${employee.employeeId}</strong></div>
    <div class="setting-card"><span>Department</span><strong>${employee.department}</strong></div>
    <div class="setting-card"><span>Role</span><strong>${employee.role}</strong></div>
    <div class="setting-card"><span>Phone</span><strong>${employee.phone || "-"}</strong></div>
  `;

  const rows = state.attendance
    .filter((record) => record.uid === employee.uid)
    .filter((record) => isWithinDateRange(record.dateKey, state.drawerFrom, state.drawerTo))
    .map((record) => {
      const hours = record.checkIn && record.checkOut ? calcHours(record.checkIn, record.checkOut) : "-";
      const status = calcStatus(record);
      const pillClass = statusPillClass(status);
      return `
      <tr>
        <td>${record.dateKey}</td>
        <td>${record.checkIn || "-"}</td>
        <td>${record.checkOut || "-"}</td>
        <td>${hours}</td>
        <td><span class="pill ${pillClass}">${status}</span></td>
      </tr>
    `;
    })
    .join("");

  elements.drawerAttendanceBody.innerHTML = rows || '<tr><td colspan="5" class="empty-state">No attendance history for this employee.</td></tr>';
}

function renderAll() {
  if (!state.user) {
    return;
  }

  renderStatusBadges();
  renderLiveOutput();
  renderUidCaptureState();
  renderEmployeeSerialStatus();
  renderMetrics();
  renderTodayAttendance();
  renderEmployeeTable();
  renderAttendanceTable();
  renderDrawer();
  renderScanFeed();
}

function bindNavButtons() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
}

function wireEvents() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.signOutBtn.addEventListener("click", () => state.auth?.signOut());
  elements.signOutBtnSecondary.addEventListener("click", () => state.auth?.signOut());
  elements.employeeForm.addEventListener("submit", handleEmployeeSubmit);
  elements.scanEmployeeUidBtn.addEventListener("click", beginEmployeeUidCapture);
  elements.clearEmployeeFormBtn.addEventListener("click", clearEmployeeForm);
  elements.employeeSearchInput.addEventListener("input", () => {
    state.employeeSearch = elements.employeeSearchInput.value;
    renderEmployeeTable();
  });
  elements.attendanceFromInput.addEventListener("change", () => {
    state.attendanceFrom = elements.attendanceFromInput.value;
    renderAttendanceTable();
  });
  elements.attendanceToInput.addEventListener("change", () => {
    state.attendanceTo = elements.attendanceToInput.value;
    renderAttendanceTable();
  });
  elements.attendanceSearchInput.addEventListener("input", () => {
    state.attendanceSearch = elements.attendanceSearchInput.value;
    renderAttendanceTable();
  });
  elements.clearAttendanceFiltersBtn.addEventListener("click", () => {
    elements.attendanceFromInput.value = "";
    elements.attendanceToInput.value = "";
    elements.attendanceSearchInput.value = "";
    state.attendanceFrom = "";
    state.attendanceTo = "";
    state.attendanceSearch = "";
    renderAttendanceTable();
  });
  elements.sampleDataBtn.addEventListener("click", loadSampleData);
  elements.connectSerialBtn.addEventListener("click", connectSerial);
  elements.disconnectSerialBtn.addEventListener("click", disconnectSerial);
  elements.connectEmployeeSerialBtn.addEventListener("click", connectSerial);
  elements.disconnectEmployeeSerialBtn.addEventListener("click", disconnectSerial);
  elements.demoScanBtn.addEventListener("click", async () => {
    if (!state.employees.length) {
      loadSampleData();
    }
    await processScan(state.employees[0]?.uid || sampleEmployees[0].uid, "demo");
  });
  elements.scanFromInputBtn.addEventListener("click", async () => {
    await processScan(elements.manualUidInput.value, "manual");
  });
  elements.manualUidInput.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await processScan(elements.manualUidInput.value, "manual");
    }
  });
  elements.drawerBackdrop.addEventListener("click", closeEmployeeDrawer);
  elements.closeDrawerBtn.addEventListener("click", closeEmployeeDrawer);
  elements.drawerFromInput.addEventListener("change", () => {
    state.drawerFrom = elements.drawerFromInput.value;
    renderDrawer();
  });
  elements.drawerToInput.addEventListener("change", () => {
    state.drawerTo = elements.drawerToInput.value;
    renderDrawer();
  });
  elements.drawerClearFiltersBtn.addEventListener("click", () => {
    elements.drawerFromInput.value = "";
    elements.drawerToInput.value = "";
    state.drawerFrom = "";
    state.drawerTo = "";
    renderDrawer();
  });
}

function initialize() {
  cacheElements();
  bindNavButtons();
  wireEvents();
  setDefaultLiveOutput();
  renderStatusBadges();

  if (hasFirebaseConfig() && window.firebase) {
    initFirebase();
  } else {
    showLogin();
    renderLiveOutput();
  }

  setView("dashboardView");
  renderUidCaptureState();
  renderEmployeeSerialStatus();
}

document.addEventListener("DOMContentLoaded", initialize);
