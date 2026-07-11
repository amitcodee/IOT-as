const appConfig = window.__APP_CONFIG__ || { appName: "TechCADD Attendance", firebase: {} };

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
  remarks: [],
  selectedEmployeeUid: "",
  employeeSearch: "",
  attendanceSearch: "",
  attendanceFrom: "",
  attendanceTo: "",
  drawerFrom: "",
  drawerTo: "",
  drawerMonth: "",
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
let remarksUnsub = null;

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
  const [inH, inM] = checkIn.split(":").map(Number);
  const [outH, outM] = checkOut.split(":").map(Number);
  let mins = outH * 60 + outM - (inH * 60 + inM);
  if (mins < 0) mins += 24 * 60;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function calcMinutes(checkIn, checkOut) {
  const [inH, inM] = checkIn.split(":").map(Number);
  const [outH, outM] = checkOut.split(":").map(Number);
  let mins = outH * 60 + outM - (inH * 60 + inM);
  if (mins < 0) mins += 24 * 60;
  return mins;
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
  if (!record) return null;
  return {
    dateKey: record.dateKey,
    uid: record.uid,
    employeeId: record.employeeId,
    employeeName: record.employeeName,
    checkIn: record.checkIn || null,
    checkOut: record.checkOut || null,
  };
}

function getEmployeeName(uid) {
  const emp = state.employees.find((e) => e.uid === uid);
  return emp ? emp.name : uid;
}

function getEmployeeId(uid) {
  const emp = state.employees.find((e) => e.uid === uid);
  return emp ? emp.employeeId : "";
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function getMonthOptions(records) {
  const months = new Set();
  records.forEach((r) => {
    if (r.dateKey) months.add(r.dateKey.slice(0, 7));
  });
  const now = new Date();
  months.add(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  return Array.from(months).sort().reverse();
}

function getMonthLabel(ym) {
  const [y, m] = ym.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[parseInt(m, 10) - 1]} ${y}`;
}

function cacheElements() {
  [
    "loginView", "appShell", "loginForm", "loginEmail", "loginPassword", "loginHint",
    "topbarTitle", "sidebarTitle", "currentUserLabel", "authStatusPill", "syncStatusPill",
    "signOutBtn", "signOutBtnSecondary",
    "dashboardView", "employeesView", "attendanceView", "settingsView",
    "metricEmployees", "metricPresent", "metricCheckedOut", "metricLate",
    "connectSerialBtn", "disconnectSerialBtn", "demoScanBtn",
    "manualUidInput", "scanFromInputBtn",
    "serialBadge", "syncBadge", "serialHint", "scannerDot", "liveOutput", "scanFeed",
    "todayAttendanceBody",
    "employeeForm", "employeeUid", "employeeId", "employeeName",
    "employeeDepartment", "employeeRole", "employeePhone",
    "connectEmployeeSerialBtn", "disconnectEmployeeSerialBtn", "employeeSerialStatus",
    "scanEmployeeUidBtn", "scanEmployeeUidHint", "clearEmployeeFormBtn",
    "employeeSearchInput", "employeeTableBody",
    "attendanceFromInput", "attendanceToInput", "attendanceSearchInput",
    "clearAttendanceFiltersBtn", "attendanceTableBody",
    "sampleDataBtn", "settingAppName", "settingProjectId",
    "settingNewPassword", "settingConfirmPassword", "updatePasswordBtn", "passwordHint",
    "drawerBackdrop", "employeeDrawer", "drawerEmployeeName", "drawerSummary",
    "drawerAttendanceBody", "drawerFromInput", "drawerToInput",
    "drawerClearFiltersBtn", "closeDrawerBtn",
    "drawerMonthSelect", "drawerMonthSummary",
    "drawerRemarkDate", "drawerRemarkInput", "drawerAddRemarkBtn", "drawerRemarkList",
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function hasFirebaseConfig() {
  const c = appConfig.firebase || {};
  return Boolean(c.apiKey && c.projectId && c.appId);
}

function initFirebase() {
  if (!window.firebase || !hasFirebaseConfig()) {
    state.syncStatus = "Local demo";
    elements.loginHint.textContent = "System is in local demo mode.";
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
    ? "Sign in with your account."
    : "System is in local demo mode.";
}

function showApp() {
  elements.loginView.classList.add("hidden");
  elements.appShell.classList.remove("hidden");
  elements.currentUserLabel.textContent = state.user?.email || "Admin";
  elements.authStatusPill.textContent = state.user?.email || "Signed in";
  elements.settingAppName.textContent = appConfig.appName || "TechCADD Attendance";
  elements.settingProjectId.textContent = appConfig.firebase?.projectId || "-";
}

function renderStatusBadges() {
  const isConnected = state.serialStatus === "Connected" || state.serialStatus === "Reader ready";
  elements.serialBadge.textContent = isConnected ? "Connected" : "Disconnected";
  elements.syncBadge.textContent = state.syncStatus;
  elements.serialHint.textContent = isConnected ? "Reader active" : "Waiting for reader";

  if (elements.scannerDot) {
    elements.scannerDot.classList.toggle("connected", isConnected);
  }
}

function renderLiveOutput() {
  elements.liveOutput.textContent = formatJson(state.liveOutput || { status: "info", message: "Ready" });
}

function renderUidCaptureState() {
  if (!elements.scanEmployeeUidBtn || !elements.scanEmployeeUidHint) return;
  if (state.captureUidForEmployee) {
    elements.scanEmployeeUidBtn.textContent = "Waiting for scanned UID...";
    elements.scanEmployeeUidBtn.disabled = true;
    elements.scanEmployeeUidHint.textContent = "Tap the RFID card on the reader now.";
    return;
  }
  elements.scanEmployeeUidBtn.textContent = "Scan Card to Assign UID";
  elements.scanEmployeeUidBtn.disabled = false;
  elements.scanEmployeeUidHint.textContent = "Ready to capture";
}

function renderEmployeeSerialStatus() {
  if (!elements.employeeSerialStatus) return;
  elements.employeeSerialStatus.textContent = state.serialStatus === "Connected" || state.serialStatus === "Reader ready"
    ? `Reader ${state.serialStatus.toLowerCase()}`
    : "Reader disconnected";
}

function setView(viewId) {
  state.view = viewId;
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("is-active", s.id === viewId));
  document.querySelectorAll(".nav-link").forEach((b) => b.classList.toggle("is-active", b.dataset.view === viewId));
  const labels = { dashboardView: "Dashboard", employeesView: "Employees", attendanceView: "Attendance", settingsView: "Settings" };
  elements.topbarTitle.textContent = labels[viewId] || "Dashboard";
  elements.sidebarTitle.textContent = labels[viewId] || "Dashboard";
}

function setDefaultLiveOutput() {
  state.liveOutput = { status: "info", message: "Connect a reader or run a demo scan" };
}

function handleFirestoreError(error) {
  const raw = error?.message || "";
  let message = "Something went wrong. Please try again.";
  if (String(raw).toLowerCase().includes("permission-denied")) {
    state.syncStatus = "Access denied";
    message = "Access denied. Contact your administrator.";
  } else if (String(raw).toLowerCase().includes("not-found")) {
    message = "Record not found.";
  } else if (String(raw).toLowerCase().includes("unavailable")) {
    message = "Service temporarily unavailable. Please try again.";
  }
  state.liveOutput = { status: "error", message };
  renderStatusBadges();
  renderLiveOutput();
}

function beginEmployeeUidCapture() {
  state.captureUidForEmployee = true;
  state.liveOutput = { status: "info", message: "Waiting for a card scan to assign the employee UID" };
  renderAll();
  if (state.serialStatus !== "Connected" && !state.serialConnecting) connectSerial();
}

function completeEmployeeUidCapture(uid) {
  elements.employeeUid.value = uid;
  state.captureUidForEmployee = false;
  state.liveOutput = { status: "success", message: `Captured UID ${uid}` };
  renderAll();
  elements.employeeUid.focus();
}

// ---- DATA ----

function readEmployees() {
  if (!state.db) {
    state.employees = sampleEmployees.map((e) => ({ ...e }));
    return null;
  }
  return state.db.collection("employees").onSnapshot((snap) => {
    state.employees = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
    renderAll();
  }, handleFirestoreError);
}

function readAttendance() {
  if (!state.db) {
    state.attendance = [];
    return null;
  }
  return state.db.collection("attendance").onSnapshot((snap) => {
    state.attendance = snap.docs
      .map((d) => normalizeAttendanceRecord(d.data()))
      .filter(Boolean)
      .sort((a, b) => `${b.dateKey}${b.checkIn || ""}`.localeCompare(`${a.dateKey}${a.checkIn || ""}`));
    renderAll();
  }, handleFirestoreError);
}

function readRemarks() {
  if (!state.db) {
    state.remarks = [];
    return null;
  }
  return state.db.collection("remarks").onSnapshot((snap) => {
    state.remarks = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.date || b.createdAt || "").localeCompare(a.date || a.createdAt || ""));
    renderDrawer();
  }, handleFirestoreError);
}

async function loadData() {
  if (!state.db) {
    state.employees = sampleEmployees.map((e) => ({ ...e }));
    state.attendance = [];
    state.remarks = [];
    return;
  }
  if (employeesUnsub) employeesUnsub();
  if (attendanceUnsub) attendanceUnsub();
  if (remarksUnsub) remarksUnsub();
  employeesUnsub = readEmployees();
  attendanceUnsub = readAttendance();
  remarksUnsub = readRemarks();
}

function filterBySearch(items, search, fields) {
  const q = search.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => fields.some((f) => String(item[f] || "").toLowerCase().includes(q)));
}

function isWithinDateRange(dateKey, from, to) {
  if (from && dateKey < from) return false;
  if (to && dateKey > to) return false;
  return true;
}

// ---- RENDER ----

function renderMetrics() {
  const today = todayKey();
  const todayRecs = state.attendance.filter((r) => r.dateKey === today);
  elements.metricEmployees.textContent = state.employees.length;
  elements.metricPresent.textContent = todayRecs.filter((r) => r.checkIn && !r.checkOut).length;
  elements.metricCheckedOut.textContent = todayRecs.filter((r) => Boolean(r.checkOut)).length;
  elements.metricLate.textContent = todayRecs.length;
}

function attendanceRow(record) {
  const hours = record.checkIn && record.checkOut ? calcHours(record.checkIn, record.checkOut) : "-";
  const status = calcStatus(record);
  const pillClass = statusPillClass(status);
  return `<tr>
    <td>${record.dateKey || "-"}</td>
    <td>${record.employeeName || getEmployeeName(record.uid)}</td>
    <td>${record.uid}</td>
    <td>${record.checkIn || "-"}</td>
    <td>${record.checkOut || "-"}</td>
    <td>${hours}</td>
    <td><span class="pill ${pillClass}">${status}</span></td>
  </tr>`;
}

function renderTodayAttendance() {
  const today = todayKey();
  const rows = state.attendance.filter((r) => r.dateKey === today).map(attendanceRow).join("");
  elements.todayAttendanceBody.innerHTML = rows || '<tr><td colspan="7" class="empty-state">No attendance records for today.</td></tr>';
}

function employeeRow(employee) {
  return `<tr>
    <td>${employee.uid}</td>
    <td>${employee.employeeId}</td>
    <td><strong>${employee.name}</strong></td>
    <td>${employee.department}</td>
    <td>${employee.role}</td>
    <td>
      <button class="mini-btn" data-view-employee="${employee.uid}" type="button">View</button>
      <button class="mini-btn" data-edit-employee="${employee.uid}" type="button">Edit</button>
      <button class="mini-btn" data-delete-employee="${employee.uid}" type="button">Delete</button>
    </td>
  </tr>`;
}

function renderEmployeeTable() {
  const filtered = filterBySearch(state.employees, state.employeeSearch, ["uid", "employeeId", "name", "department", "role"]);
  elements.employeeTableBody.innerHTML = filtered.map(employeeRow).join("") || '<tr><td colspan="6" class="empty-state">No employees found.</td></tr>';

  elements.employeeTableBody.querySelectorAll("[data-view-employee]").forEach((btn) => {
    btn.addEventListener("click", () => openEmployeeDrawer(btn.getAttribute("data-view-employee")));
  });
  elements.employeeTableBody.querySelectorAll("[data-edit-employee]").forEach((btn) => {
    btn.addEventListener("click", () => fillEmployeeForm(btn.getAttribute("data-edit-employee")));
  });
  elements.employeeTableBody.querySelectorAll("[data-delete-employee]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.getAttribute("data-delete-employee");
      if (uid && confirm(`Delete employee ${uid}?`)) await deleteEmployee(uid);
    });
  });
}

function renderAttendanceTable() {
  const filtered = filterBySearch(
    state.attendance.filter((r) => isWithinDateRange(r.dateKey, state.attendanceFrom, state.attendanceTo)),
    state.attendanceSearch,
    ["dateKey", "employeeName", "uid"],
  );
  elements.attendanceTableBody.innerHTML = filtered.map(attendanceRow).join("") || '<tr><td colspan="7" class="empty-state">No attendance records match the filters.</td></tr>';
}

function renderDrawer() {
  const employee = state.employees.find((e) => e.uid === state.selectedEmployeeUid);
  if (!employee) {
    elements.drawerEmployeeName.textContent = "Select an employee";
    elements.drawerSummary.innerHTML = '<div class="empty-state">Choose an employee to view details.</div>';
    elements.drawerAttendanceBody.innerHTML = '<tr><td colspan="5" class="empty-state">No employee selected.</td></tr>';
    elements.drawerMonthSummary.innerHTML = "";
    elements.drawerRemarkList.innerHTML = "";
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

  // Remarks
  const empRemarks = state.remarks.filter((r) => r.uid === employee.uid);
  elements.drawerRemarkList.innerHTML = empRemarks.length
    ? empRemarks.map((r) => `<div class="remark-item">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>${r.date || "-"}</strong>
          <button class="mini-btn" data-delete-remark="${r.id}" type="button" style="padding:4px 8px;font-size:0.75rem;">Delete</button>
        </div>
        ${r.text}
      </div>`).join("")
    : '<div class="empty-state" style="font-size:0.85rem;">No remarks yet.</div>';

  elements.drawerRemarkList.querySelectorAll("[data-delete-remark]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-delete-remark");
      if (id && confirm("Delete this remark?")) await deleteRemark(id);
    });
  });

  // Attendance for this employee
  const empRecords = state.attendance.filter((r) => r.uid === employee.uid);

  // Month select
  const months = getMonthOptions(empRecords);
  const currentMonth = state.drawerMonth || months[0] || "";
  elements.drawerMonthSelect.innerHTML = '<option value="">All Months</option>' + months.map((m) => `<option value="${m}" ${m === currentMonth ? "selected" : ""}>${getMonthLabel(m)}</option>`).join("");

  // Filter records
  let filtered = empRecords;
  if (state.drawerMonth) {
    filtered = filtered.filter((r) => r.dateKey && r.dateKey.startsWith(state.drawerMonth));
  }
  if (state.drawerFrom || state.drawerTo) {
    filtered = filtered.filter((r) => isWithinDateRange(r.dateKey, state.drawerFrom, state.drawerTo));
  }

  // Month summary
  const summaryRecords = state.drawerMonth
    ? empRecords.filter((r) => r.dateKey && r.dateKey.startsWith(state.drawerMonth))
    : empRecords;

  const totalDays = summaryRecords.length;
  const checkedOutDays = summaryRecords.filter((r) => r.checkIn && r.checkOut).length;
  const presentDays = summaryRecords.filter((r) => r.checkIn).length;
  let totalMins = 0;
  summaryRecords.forEach((r) => {
    if (r.checkIn && r.checkOut) totalMins += calcMinutes(r.checkIn, r.checkOut);
  });
  const avgMins = checkedOutDays > 0 ? Math.round(totalMins / checkedOutDays) : 0;

  elements.drawerMonthSummary.innerHTML = `
    <div class="month-stat"><span>Total Days</span><strong>${totalDays}</strong></div>
    <div class="month-stat"><span>Present</span><strong>${presentDays}</strong></div>
    <div class="month-stat"><span>Completed</span><strong>${checkedOutDays}</strong></div>
    <div class="month-stat"><span>Total Hours</span><strong>${Math.floor(totalMins / 60)}h ${totalMins % 60}m</strong></div>
    <div class="month-stat"><span>Avg / Day</span><strong>${Math.floor(avgMins / 60)}h ${avgMins % 60}m</strong></div>
  `;

  // Table
  const rows = filtered.map((record) => {
    const hours = record.checkIn && record.checkOut ? calcHours(record.checkIn, record.checkOut) : "-";
    const status = calcStatus(record);
    const pillClass = statusPillClass(status);
    return `<tr>
      <td>${record.dateKey}</td>
      <td>${record.checkIn || "-"}</td>
      <td>${record.checkOut || "-"}</td>
      <td>${hours}</td>
      <td><span class="pill ${pillClass}">${status}</span></td>
    </tr>`;
  }).join("");

  elements.drawerAttendanceBody.innerHTML = rows || '<tr><td colspan="5" class="empty-state">No attendance records found.</td></tr>';
}

function renderScanFeed() {
  if (!state.scanFeed.length) {
    elements.scanFeed.innerHTML = '<div class="feed-item"><strong>No scan activity yet</strong><span>Connect the ESP32 or run a demo scan.</span></div>';
    return;
  }
  elements.scanFeed.innerHTML = state.scanFeed.slice(0, 6).map((entry) => `
    <div class="feed-item">
      <strong>${entry.name || "Unknown"} <span class="pill ${entry.type === "error" ? "error" : entry.type === "CHECK_OUT" ? "out" : entry.type === "CHECK_IN" ? "info" : "done"}">${entry.type}</span></strong>
      <span>${entry.message}</span>
      <span>${entry.uid || "No UID"} &bull; ${entry.time} &bull; ${entry.source}</span>
    </div>
  `).join("");
}

function renderAll() {
  if (!state.user) return;
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

// ---- ACTIONS ----

function clearEmployeeForm() {
  elements.employeeForm.reset();
  state.captureUidForEmployee = false;
  renderUidCaptureState();
  elements.employeeUid.focus();
}

function fillEmployeeForm(uid) {
  const emp = state.employees.find((e) => e.uid === uid);
  if (!emp) return;
  elements.employeeUid.value = emp.uid;
  elements.employeeId.value = emp.employeeId || "";
  elements.employeeName.value = emp.name || "";
  elements.employeeDepartment.value = emp.department || "";
  elements.employeeRole.value = emp.role || "";
  elements.employeePhone.value = emp.phone || "";
  setView("employeesView");
}

function openEmployeeDrawer(uid) {
  state.selectedEmployeeUid = uid;
  state.drawerFrom = "";
  state.drawerTo = "";
  state.drawerMonth = "";
  elements.drawerFromInput.value = "";
  elements.drawerToInput.value = "";
  elements.drawerRemarkInput.value = "";
  elements.drawerRemarkDate.value = todayKey();
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
    const idx = state.employees.findIndex((e) => e.uid === employee.uid);
    if (idx >= 0) state.employees[idx] = employee;
    else state.employees.unshift(employee);
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
    state.employees = state.employees.filter((e) => e.uid !== uid);
    state.attendance = state.attendance.filter((e) => e.uid !== uid);
    state.remarks = state.remarks.filter((e) => e.uid !== uid);
    renderAll();
    return;
  }
  try {
    // Delete employee
    await state.db.collection("employees").doc(uid).delete();

    // Delete all attendance for this employee
    const attSnap = await state.db.collection("attendance").where("uid", "==", uid).get();
    const attBatch = state.db.batch();
    attSnap.forEach((doc) => attBatch.delete(doc.ref));
    if (!attSnap.empty) await attBatch.commit();

    // Delete all remarks for this employee
    const remSnap = await state.db.collection("remarks").where("uid", "==", uid).get();
    const remBatch = state.db.batch();
    remSnap.forEach((doc) => remBatch.delete(doc.ref));
    if (!remSnap.empty) await remBatch.commit();
  } catch (error) {
    handleFirestoreError(error);
    throw error;
  }
}

async function saveAttendance(record) {
  if (!state.db) {
    const key = `${record.dateKey}_${record.uid}`;
    const idx = state.attendance.findIndex((e) => `${e.dateKey}_${e.uid}` === key);
    if (idx >= 0) state.attendance[idx] = normalizeAttendanceRecord(record);
    else state.attendance.unshift(normalizeAttendanceRecord(record));
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

async function addRemark(uid, text, date) {
  if (!text.trim()) return;
  const remark = {
    uid,
    text: text.trim(),
    date: date || todayKey(),
    createdAt: new Date().toISOString(),
  };
  if (!state.db) {
    state.remarks.unshift({ id: Date.now().toString(), ...remark });
    renderDrawer();
    return;
  }
  try {
    await state.db.collection("remarks").add(remark);
  } catch (error) {
    handleFirestoreError(error);
  }
}

async function deleteRemark(remarkId) {
  if (!remarkId) return;
  if (!state.db) {
    state.remarks = state.remarks.filter((r) => r.id !== remarkId);
    renderDrawer();
    return;
  }
  try {
    await state.db.collection("remarks").doc(remarkId).delete();
  } catch (error) {
    handleFirestoreError(error);
  }
}

async function getAttendanceRecord(uid, dateKey) {
  const local = state.attendance.find((e) => e.uid === uid && e.dateKey === dateKey);
  if (local || !state.db) return normalizeAttendanceRecord(local);
  let snap;
  try {
    snap = await state.db.collection("attendance").doc(`${dateKey}_${uid}`).get();
  } catch (error) {
    handleFirestoreError(error);
    return null;
  }
  return snap.exists ? normalizeAttendanceRecord(snap.data()) : null;
}

async function processScan(rawUid, source = "manual") {
  const uid = normalizeUid(rawUid);
  const now = new Date();
  const time = formatTime(now);
  const dateKey = todayKey(now);

  if (state.captureUidForEmployee) {
    if (uid) completeEmployeeUidCapture(uid);
    return;
  }

  const employee = state.employees.find((e) => e.uid === uid);

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

  let daily = await getAttendanceRecord(uid, dateKey);

  if (!daily) {
    daily = { uid, employeeId: employee.employeeId, employeeName: employee.name, dateKey, checkIn: time, checkOut: null };
    state.liveOutput = { status: "success", type: "CHECK_IN", employee: employee.name, employee_id: employee.employeeId, check_in: time, uid };
    state.scanFeed.unshift({ uid, type: "CHECK_IN", name: employee.name, message: `${employee.name} checked in`, time, source });
    state.scanFeed = state.scanFeed.slice(0, 8);
    state.attendance.unshift(daily);
    await saveAttendance(daily);
    renderAll();
    return;
  }

  if (!daily.checkOut) {
    daily.checkOut = time;
    state.liveOutput = { status: "success", type: "CHECK_OUT", employee: employee.name, employee_id: employee.employeeId, check_in: daily.checkIn, check_out: time, uid };
    state.scanFeed.unshift({ uid, type: "CHECK_OUT", name: employee.name, message: `${employee.name} checked out`, time, source });
    state.scanFeed = state.scanFeed.slice(0, 8);
    const idx = state.attendance.findIndex((e) => e.uid === uid && e.dateKey === dateKey);
    if (idx >= 0) state.attendance[idx] = daily;
    else state.attendance.unshift(daily);
    await saveAttendance(daily);
    renderAll();
    return;
  }

  state.liveOutput = { status: "info", type: "ALREADY_DONE", employee: employee.name, message: "Already checked in and out today", uid, time };
  state.scanFeed.unshift({ uid, type: "done", name: employee.name, message: "Already checked in and out today", time, source });
  state.scanFeed = state.scanFeed.slice(0, 8);
  renderAll();
}

function loadSampleData() {
  state.employees = sampleEmployees.map((e) => ({ ...e }));
  state.liveOutput = { status: "success", message: "Sample employees loaded" };
  if (state.db) {
    Promise.all(sampleEmployees.map((e) => state.db.collection("employees").doc(e.uid).set(e, { merge: true }))).then(() => renderAll());
  } else {
    renderAll();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  if (!state.auth) {
    elements.loginHint.textContent = "System is not configured. Contact administrator.";
    return;
  }
  const email = elements.loginEmail.value.trim();
  const password = elements.loginPassword.value;
  try {
    await state.auth.signInWithEmailAndPassword(email, password);
  } catch (error) {
    const code = error?.code || "";
    if (code.includes("user-not-found") || code.includes("invalid-credential")) {
      elements.loginHint.textContent = "Username not found. Please check your credentials.";
    } else if (code.includes("wrong-password")) {
      elements.loginHint.textContent = "Incorrect password. Please try again.";
    } else if (code.includes("too-many-requests")) {
      elements.loginHint.textContent = "Too many attempts. Please try again later.";
    } else if (code.includes("invalid-email")) {
      elements.loginHint.textContent = "Invalid email format.";
    } else {
      elements.loginHint.textContent = "Unable to sign in. Please try again.";
    }
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
    alert("Please complete all required fields.");
    return;
  }
  await saveEmployee(employee);
  clearEmployeeForm();
  renderAll();
}

// ---- SERIAL ----

async function disconnectSerial() {
  state.serialConnecting = false;
  const port = state.serialPort;
  const reader = state.serialReader;
  const streamClosed = state.serialStreamClosed;
  state.serialPort = null;
  state.serialReader = null;
  state.serialDecoder = null;
  state.serialStreamClosed = null;
  try { await reader?.cancel(); } catch {}
  try { if (streamClosed) await streamClosed.catch(() => null); } catch {}
  try { reader?.releaseLock(); } catch {}
  try { await port?.close(); } catch {}
  state.serialStatus = "Disconnected";
  renderStatusBadges();
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    alert("This browser does not support Web Serial. Use Chrome or Edge.");
    return;
  }
  if (state.serialConnecting || state.serialStatus === "Connected") return;
  state.serialConnecting = true;
  elements.connectSerialBtn.disabled = true;
  try {
    if (state.serialPort || state.serialReader || state.serialDecoder || state.serialStreamClosed) await disconnectSerial();
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
      if (done) break;
      buffer += value;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === "RFID_READY") { state.serialStatus = "Reader ready"; renderStatusBadges(); continue; }
        if (trimmed.startsWith("UID:")) await processScan(trimmed.slice(4), "serial");
      }
    }
    await state.serialStreamClosed?.catch(() => null);
  } catch (error) {
    state.liveOutput = { status: "error", message: error.message || "Unable to connect" };
    renderAll();
  } finally {
    state.serialConnecting = false;
    elements.connectSerialBtn.disabled = false;
    if (elements.connectEmployeeSerialBtn) elements.connectEmployeeSerialBtn.disabled = false;
  }
}

// ---- WIRING ----

function bindNavButtons() {
  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
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

  elements.attendanceFromInput.addEventListener("change", () => { state.attendanceFrom = elements.attendanceFromInput.value; renderAttendanceTable(); });
  elements.attendanceToInput.addEventListener("change", () => { state.attendanceTo = elements.attendanceToInput.value; renderAttendanceTable(); });
  elements.attendanceSearchInput.addEventListener("input", () => { state.attendanceSearch = elements.attendanceSearchInput.value; renderAttendanceTable(); });
  elements.clearAttendanceFiltersBtn.addEventListener("click", () => {
    elements.attendanceFromInput.value = "";
    elements.attendanceToInput.value = "";
    elements.attendanceSearchInput.value = "";
    state.attendanceFrom = "";
    state.attendanceTo = "";
    state.attendanceSearch = "";
    renderAttendanceTable();
  });

  elements.updatePasswordBtn.addEventListener("click", async () => {
    const newPass = elements.settingNewPassword.value;
    const confirmPass = elements.settingConfirmPassword.value;
    if (!newPass || !confirmPass) {
      elements.passwordHint.textContent = "Please fill both fields.";
      return;
    }
    if (newPass !== confirmPass) {
      elements.passwordHint.textContent = "Passwords do not match.";
      return;
    }
    if (newPass.length < 6) {
      elements.passwordHint.textContent = "Password must be at least 6 characters.";
      return;
    }
    try {
      await state.user.updatePassword(newPass);
      elements.passwordHint.textContent = "Password updated successfully.";
      elements.settingNewPassword.value = "";
      elements.settingConfirmPassword.value = "";
    } catch (error) {
      const code = error?.code || "";
      if (code.includes("requires-recent-login")) {
        elements.passwordHint.textContent = "Please sign out and sign in again before changing password.";
      } else {
        elements.passwordHint.textContent = "Failed to update password. Please try again.";
      }
    }
  });

  elements.sampleDataBtn.addEventListener("click", loadSampleData);
  elements.connectSerialBtn.addEventListener("click", connectSerial);
  elements.disconnectSerialBtn.addEventListener("click", disconnectSerial);
  elements.connectEmployeeSerialBtn.addEventListener("click", connectSerial);
  elements.disconnectEmployeeSerialBtn.addEventListener("click", disconnectSerial);

  elements.demoScanBtn.addEventListener("click", async () => {
    if (!state.employees.length) loadSampleData();
    await processScan(state.employees[0]?.uid || sampleEmployees[0].uid, "demo");
  });
  elements.scanFromInputBtn.addEventListener("click", async () => { await processScan(elements.manualUidInput.value, "manual"); });
  elements.manualUidInput.addEventListener("keydown", async (e) => { if (e.key === "Enter") { e.preventDefault(); await processScan(elements.manualUidInput.value, "manual"); } });

  // Drawer events
  elements.drawerBackdrop.addEventListener("click", closeEmployeeDrawer);
  elements.closeDrawerBtn.addEventListener("click", closeEmployeeDrawer);
  elements.drawerFromInput.addEventListener("change", () => { state.drawerFrom = elements.drawerFromInput.value; renderDrawer(); });
  elements.drawerToInput.addEventListener("change", () => { state.drawerTo = elements.drawerToInput.value; renderDrawer(); });
  elements.drawerMonthSelect.addEventListener("change", () => { state.drawerMonth = elements.drawerMonthSelect.value; renderDrawer(); });
  elements.drawerClearFiltersBtn.addEventListener("click", () => {
    elements.drawerFromInput.value = "";
    elements.drawerToInput.value = "";
    state.drawerFrom = "";
    state.drawerTo = "";
    state.drawerMonth = "";
    renderDrawer();
  });

  // Remark
  elements.drawerAddRemarkBtn.addEventListener("click", async () => {
    if (!state.selectedEmployeeUid) return;
    const text = elements.drawerRemarkInput.value;
    const date = elements.drawerRemarkDate.value || todayKey();
    if (!text.trim()) return;
    await addRemark(state.selectedEmployeeUid, text, date);
    elements.drawerRemarkInput.value = "";
    elements.drawerRemarkDate.value = "";
  });
  elements.drawerRemarkInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!state.selectedEmployeeUid) return;
      const text = elements.drawerRemarkInput.value;
      const date = elements.drawerRemarkDate.value || todayKey();
      if (!text.trim()) return;
      await addRemark(state.selectedEmployeeUid, text, date);
      elements.drawerRemarkInput.value = "";
      elements.drawerRemarkDate.value = "";
    }
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
