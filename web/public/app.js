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
  role: null,
  users: [],
  devices: [],
  editTimeRecord: null,
  employees: [],
  attendance: [],
  remarks: [],
  selectedEmployeeUid: "",
  editingEmployeeUid: "", // set while the Add/Edit form is editing an existing employee
  employeeSearch: "",
  attendanceSearch: "",
  attendanceFrom: "",
  attendanceTo: "",
  attendanceEmployeeUid: "",
  drawerFrom: "",
  drawerTo: "",
  drawerMonth: "",
  calendarMonth: "",
  calendarPageMonth: "",
  calendarSelectedDate: "",
  shiftEditorDate: "",
  unknownCards: [],
  assigningCardUid: "",
  view: "dashboardView",
  serialStatus: "Disconnected",
  syncStatus: "Local demo",
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
const scanCooldowns = new Map();
const SCAN_COOLDOWN_MS = 90000; // 90 seconds cooldown per UID
let employeesUnsub = null;
let attendanceUnsub = null;
let remarksUnsub = null;
let usersUnsub = null;
let devicesUnsub = null;
let unknownCardsUnsub = null;
const pageOpenedAt = Date.now();
const toastedCardScans = new Set();

const ROLE_LABELS = {
  super_admin: "Super Admin",
  hr: "HR",
  employee: "Employee",
  device: "Device",
};

// Local calendar date (YYYY-MM-DD). Must be local, not UTC: check-in times (formatTime) and the ESP32
// firmware's dateKey are both local, so a UTC date would be a day behind for the first hours of the
// day in timezones ahead of UTC (e.g. 00:00-05:30 in India).
function todayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTime(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

function normalizeUid(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// An employee whose card was removed keeps their data under a placeholder key. It contains "-", which a
// real card UID never does (normalizeUid strips it), so no reader can ever match it.
const NO_CARD_PREFIX = "NOCARD-";

function hasCard(uid) {
  return Boolean(uid) && !String(uid).startsWith(NO_CARD_PREFIX);
}

function cardLabel(uid) {
  return hasCard(uid) ? uid : "No card";
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

// Shift maths (default / per-day shifts, late, early leave, overtime, day type) lives in shifts.js,
// shared with the Employee Portal.
function getEmployeeShift(employee) {
  return employeeDefaultShift(employee);
}

function getShiftFor(uid, dateKey) {
  return shiftForEmployee(state.employees.find((e) => e.uid === uid), dateKey);
}

function timingCell(record, shift) {
  const timing = shiftTiming(record, shift);
  const parts = [];
  if (timing.hasIn) {
    parts.push(`<span class="pill ${timing.lateMins > 0 ? "error" : "done"}">${escapeHtml(inRemark(timing))}</span>`);
  }
  if (timing.hasOut) {
    parts.push(`<span class="pill ${timing.earlyLeaveMins > 0 ? "error" : timing.overtimeMins > 0 ? "info" : "done"}">${escapeHtml(outRemark(timing))}</span>`);
  }
  return parts.length ? `<div class="timing-pills">${parts.join("")}</div>` : "-";
}

function shiftCell(shift) {
  return `${escapeHtml(formatShift(shift))}${shift.custom ? ' <span class="pill info">Custom</span>' : ""}`;
}

function statusPillClass(status) {
  if (status === "Present") return "info";
  if (status === "Checked Out") return "done";
  if (status === "Absent") return "error";
  return "";
}

function normalizeAttendanceRecord(record) {
  if (!record) return null;
  const normalized = {
    dateKey: record.dateKey,
    uid: record.uid,
    employeeId: record.employeeId,
    employeeName: record.employeeName,
    checkIn: record.checkIn || null,
    checkOut: record.checkOut || null,
    checkInLocation: record.checkInLocation || null,
    checkOutLocation: record.checkOutLocation || null,
  };
  // The Employee Portal stamps when a location was verified. Carry those through: leaving them out
  // here made every dashboard save (scan, Edit Time) silently erase them.
  if (record.checkInLocationAt) normalized.checkInLocationAt = record.checkInLocationAt;
  if (record.checkOutLocationAt) normalized.checkOutLocationAt = record.checkOutLocationAt;
  return normalized;
}

// Locations come from the database, and an employee can write their own attendance location fields,
// so never assume the shape: only finite numbers are ever rendered or put in a URL.
function validLocation(location) {
  return Number.isFinite(location?.lat) && Number.isFinite(location?.lng) ? { lat: location.lat, lng: location.lng } : null;
}

function getCurrentLocation(timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });
}

function locationMapsUrl(location) {
  const loc = validLocation(location);
  return loc ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : "";
}

function locationRow(label, location) {
  const loc = validLocation(location);
  if (!loc) return "";
  const coords = `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
  return `<div class="location-row">
    <span class="location-label">${label}</span>
    <span class="location-coords">${coords}</span>
    <a href="${locationMapsUrl(loc)}" target="_blank" rel="noopener noreferrer" class="mini-btn" title="${label} location">View</a>
  </div>`;
}

function locationCell(record) {
  const rows = [locationRow("In", record.checkInLocation), locationRow("Out", record.checkOutLocation)].filter(Boolean);
  return rows.length ? rows.join("") : "-";
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

function daysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

function firstWeekdayOfMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).getDay();
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Escape anything read from the database before it goes into innerHTML / an attribute.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function truncateText(text, max) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function cacheElements() {
  [
    "loginView", "appShell", "loginForm", "loginEmail", "loginPassword", "loginHint",
    "topbarTitle", "sidebarTitle", "currentUserLabel", "authStatusPill", "roleStatusPill",
    "signOutBtn", "signOutBtnSecondary",
    "dashboardView", "employeeAddView", "managerView", "attendanceTodayView",
    "attendanceView", "calendarView", "settingsView", "usersView", "usersNavLink",
    "devicesView", "devicesNavLink", "devicesTableBody",
    "usersFormTitle", "usersListTitle",
    "userForm", "userName", "userEmail", "userPassword", "userRole",
    "userEmployeeLinkWrap", "userEmployeeLink", "userFormHint", "usersTableBody", "createUserBtn",
    "editTimeBackdrop", "editTimeModal", "editTimeTitle", "closeEditTimeBtn",
    "editTimeCheckIn", "editTimeCheckOut", "editTimeHint", "clearEditTimeBtn", "saveEditTimeBtn",
    "metricEmployees", "metricPresent", "metricCheckedOut", "metricLate",
    "connectSerialBtn", "disconnectSerialBtn", "demoScanBtn",
    "manualUidInput", "scanFromInputBtn",
    "serialBadge", "syncBadge", "serialHint", "scannerDot", "liveOutput", "scanFeed",
    "todayAttendanceBody",
    "employeeForm", "employeeUid", "employeeId", "employeeName", "employeeBranch",
    "employeeDepartment", "employeeRole", "employeePhone", "clearEmployeeFormBtn",
    "employeeSearchInput", "employeeTableBody",
    "attendanceEmployeeFilter", "attendanceFromInput", "attendanceToInput", "attendanceSearchInput",
    "clearAttendanceFiltersBtn", "attendanceTableBody",
    "sampleDataBtn", "settingAppName", "settingProjectId",
    "settingNewPassword", "settingConfirmPassword", "updatePasswordBtn", "passwordHint",
    "drawerBackdrop", "employeeDrawer", "drawerEmployeeName", "drawerSummary",
    "drawerAttendanceBody", "drawerFromInput", "drawerToInput",
    "drawerClearFiltersBtn", "closeDrawerBtn",
    "drawerMonthSelect", "drawerMonthSummary",
    "drawerRemarkDate", "drawerRemarkInput", "drawerAddRemarkBtn", "drawerRemarkList",
    "drawerCalendarGrid", "drawerCalendarLabel", "drawerCalPrevBtn", "drawerCalNextBtn",
    "calPrevBtn", "calNextBtn", "calLabel", "calGrid",
    "calSideDateTag", "calSideDateLabel", "calSideList",
    "shiftEmployeeSelect", "shiftFromDate", "shiftToDate", "shiftPresetSelect", "shiftStartInput", "shiftEndInput",
    "saveShiftBtn", "resetShiftBtn", "shiftHint", "downloadSheetBtn", "drawerDownloadBtn",
    "employeeShiftPreset", "employeeShiftStart", "employeeShiftEnd",
    "unassignedList", "unassignedCount", "unassignedNavBadge", "assignBanner",
    "cardToast", "cardToastText", "cardToastAssignBtn", "cardToastCloseBtn",
    "sidebar", "sidebarBackdrop", "openSidebarBtn", "closeSidebarBtn",
    "trendRate", "trendChart", "metricRateText", "metricRateBar", "bestEmployees", "dockMoreBtn",
    "deleteEmpBackdrop", "deleteEmpModal", "deleteEmpTag", "deleteEmpTitle", "closeDeleteEmpBtn",
    "removeCardOnlyBtn", "deleteEverythingBtn", "deleteEverythingText", "deleteEmpHint",
    "assignCardBackdrop", "assignCardModal", "assignCardTitle", "closeAssignCardBtn",
    "assignCardInput", "assignCardOptions", "assignCardHint", "saveAssignCardBtn",
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
      const allowed = await loadMyRole();
      if (!allowed) {
        await state.auth.signOut();
        return;
      }
      await loadData();
      showApp();
      applyRoleUI();
      renderAll();
    } else {
      state.role = null;
      showLogin();
    }
  });
}

let pendingLoginMessage = "";

async function loadMyRole() {
  try {
    const snap = await state.db.collection("users").doc(state.user.uid).get();
    if (!snap.exists) {
      pendingLoginMessage = "Your account is not set up yet. Ask your super admin to grant access.";
      return false;
    }
    const data = snap.data();
    if (data.role !== "super_admin" && data.role !== "hr") {
      pendingLoginMessage = "This login is for staff only. Use the Employee Portal to view your own attendance.";
      return false;
    }
    state.role = data.role;
    return true;
  } catch (error) {
    pendingLoginMessage = "Unable to verify your account. Please try again.";
    return false;
  }
}

// Who may create logins: the Super Admin makes any kind (HR, admin, employee); HR makes employee logins only.
function canManageLogins() {
  return state.role === "super_admin" || state.role === "hr";
}

function applyUsersPanelForRole() {
  const isHr = state.role === "hr";
  // HR can make HR and employee logins, never a Super Admin (Edit Time stays with Super Admin).
  elements.userRole.innerHTML = isHr
    ? '<option value="hr">HR</option><option value="employee" selected>Employee</option>'
    : '<option value="super_admin">Super Admin</option><option value="hr">HR</option><option value="employee" selected>Employee</option>';
  elements.userRole.dispatchEvent(new Event("change"));
  elements.usersFormTitle.textContent = isHr ? "Add HR or employee access" : "Add super admin, HR or employee access";
  elements.usersListTitle.textContent = "Everyone who can sign in";
}

function applyRoleUI() {
  const isSuperAdmin = state.role === "super_admin";
  elements.usersNavLink.classList.toggle("hidden", !canManageLogins());
  applyUsersPanelForRole();
  elements.devicesNavLink.classList.toggle("hidden", !canManageLogins());
  elements.sampleDataBtn.classList.toggle("hidden", !isSuperAdmin);
  elements.roleStatusPill.textContent = ROLE_LABELS[state.role] || "";
  elements.roleStatusPill.className = `status-pill role-${state.role}`;
}

function showLogin() {
  elements.loginView.classList.remove("hidden");
  elements.appShell.classList.add("hidden");
  if (pendingLoginMessage) {
    elements.loginHint.textContent = pendingLoginMessage;
    pendingLoginMessage = "";
  } else {
    elements.loginHint.textContent = hasFirebaseConfig()
      ? "Sign in with your account."
      : "System is in local demo mode.";
  }
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

const VIEW_LABELS = {
  dashboardView: "Dashboard",
  employeeAddView: "Add Employee",
  managerView: "Manager",
  attendanceTodayView: "Attendance Today",
  attendanceView: "Attendance",
  calendarView: "Calendar",
  settingsView: "Settings",
  usersView: "Users",
  devicesView: "Devices",
};

function setView(viewId) {
  state.view = viewId;
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("is-active", s.id === viewId));
  document.querySelectorAll(".nav-link, .dock-link").forEach((b) => b.classList.toggle("is-active", b.dataset.view === viewId));
  // Views without their own dock button light up "More" (they live in the full menu).
  if (elements.dockMoreBtn) {
    const inDock = [...document.querySelectorAll(".dock-link[data-view]")].some((b) => b.dataset.view === viewId);
    elements.dockMoreBtn.classList.toggle("is-active", !inDock);
  }
  elements.topbarTitle.textContent = VIEW_LABELS[viewId] || "Dashboard";
  elements.sidebarTitle.textContent = VIEW_LABELS[viewId] || "Dashboard";
}

function router() {
  const raw = (location.hash || "").replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean);
  const [section, sub] = parts;

  if (section === "calendar") {
    setView("calendarView");
    if (sub && /^\d{4}-\d{2}-\d{2}$/.test(sub)) {
      state.calendarPageMonth = sub.slice(0, 7);
      state.calendarSelectedDate = sub;
    } else {
      state.calendarPageMonth = state.calendarPageMonth || todayKey().slice(0, 7);
    }
    renderCompanyCalendar();
    renderCalendarSidePanel();
    renderShiftEditor();
    return;
  }

  if (section === "employees" && sub === "manager") { setView("managerView"); return; }
  if (section === "employees") { setView("employeeAddView"); return; }
  if (section === "attendance" && sub === "today") { setView("attendanceTodayView"); return; }
  if (section === "attendance") { setView("attendanceView"); return; }
  if (section === "settings") { setView("settingsView"); return; }
  if (section === "users") {
    if (!canManageLogins()) { location.hash = "#dashboard"; return; }
    setView("usersView");
    return;
  }
  if (section === "devices") {
    if (!canManageLogins()) { location.hash = "#dashboard"; return; }
    setView("devicesView");
    return;
  }
  setView("dashboardView");
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

function readUsers() {
  if (!state.db || !canManageLogins()) {
    state.users = [];
    return null;
  }
  return state.db.collection("users").onSnapshot((snap) => {
    state.users = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.email || a.name || "").localeCompare(b.email || b.name || ""));
    renderUsersTable();
    renderDevicesTable(); // a reader's Pending/Approved status comes from its users/{uid} doc
  }, handleFirestoreError);
}

function readDevices() {
  if (!state.db || !canManageLogins()) {
    state.devices = [];
    return null;
  }
  return state.db.collection("devices").onSnapshot((snap) => {
    state.devices = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.requestedAt || "").localeCompare(String(a.requestedAt || "")));
    renderDevicesTable();
  }, handleFirestoreError);
}

// Cards tapped at a reader that belong to no employee yet (written by the reader, see firestore.rules).
function readUnknownCards() {
  if (!state.db || !["super_admin", "hr"].includes(state.role)) {
    state.unknownCards = [];
    return null;
  }
  return state.db.collection("unknownCards").onSnapshot((snap) => {
    state.unknownCards = snap.docs
      .map((d) => ({ ...d.data(), uid: d.id }))
      .sort((a, b) => String(b.lastScanAt || "").localeCompare(String(a.lastScanAt || "")));
    snap.docChanges().forEach((change) => {
      if (change.type === "removed") return;
      const card = change.doc.data();
      const at = new Date(card.lastScanAt || 0).getTime();
      const key = `${change.doc.id}|${card.lastScanAt}`;
      if (at > pageOpenedAt - 60000 && !toastedCardScans.has(key)) {
        toastedCardScans.add(key);
        showCardToast(change.doc.id, card.readerName);
      }
    });
    renderUnknownCards();
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
  if (usersUnsub) usersUnsub();
  if (devicesUnsub) devicesUnsub();
  if (unknownCardsUnsub) unknownCardsUnsub();
  employeesUnsub = readEmployees();
  attendanceUnsub = readAttendance();
  remarksUnsub = readRemarks();
  usersUnsub = readUsers();
  devicesUnsub = readDevices();
  unknownCardsUnsub = readUnknownCards();
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
  elements.metricLate.textContent = todayRecs.filter((r) => r.checkIn && shiftTiming(r, getShiftFor(r.uid, r.dateKey)).lateMins > 0).length;

  const total = state.employees.length;
  const inToday = todayRecs.filter((r) => r.checkIn && state.employees.some((e) => e.uid === r.uid)).length;
  const pct = total ? Math.round((inToday / total) * 100) : 0;
  if (elements.metricRateText) elements.metricRateText.textContent = `${inToday} / ${total}`;
  if (elements.metricRateBar) elements.metricRateBar.style.width = `${Math.min(pct, 100)}%`;
  renderTrendChart();
  renderBestEmployees();
}

// ---- AVATARS (initials on a soft colour picked from the name) ----
const AVATAR_TONES = ["#F6C9A8", "#BFE3C0", "#C9D6F6", "#F3D27A", "#E7C3EE", "#A9DDE0", "#F4B9B9"];

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function avatarHtml(name, extraClass = "") {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const tone = AVATAR_TONES[h % AVATAR_TONES.length];
  return `<span class="avatar ${extraClass}" style="background:${tone}" title="${escapeHtml(s)}">${escapeHtml(initials(s))}</span>`;
}

// ---- DASHBOARD: attendance trend + best employees ----
function lastNDays(n) {
  const now = new Date();
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    keys.push(todayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return keys;
}

function renderTrendChart() {
  if (!elements.trendChart) return;
  const days = lastNDays(14);
  const today = todayKey();
  const total = state.employees.length;
  const uids = new Set(state.employees.map((e) => e.uid));
  const counts = days.map((k) => new Set(state.attendance.filter((r) => r.dateKey === k && r.checkIn && uids.has(r.uid)).map((r) => r.uid)).size);
  const max = Math.max(total, ...counts, 1);
  // Average over days someone worked (skips weekends / holidays with no check-ins).
  const worked = counts.filter((c) => c > 0);
  const avg = total && worked.length ? Math.round((worked.reduce((a, b) => a + b, 0) / worked.length / total) * 100) : 0;
  elements.trendRate.textContent = `${avg}%`;
  elements.trendRate.title = "Average share of employees checked in on working days";
  elements.trendChart.innerHTML = `
    <div class="trend-bars">
      ${days.map((k, i) => {
        const pct = total ? Math.round((counts[i] / total) * 100) : 0;
        const h = counts[i] ? Math.max((counts[i] / max) * 100, 6) : 2;
        const tone = !counts[i] ? "none" : pct >= 80 ? "high" : pct >= 50 ? "mid" : "low";
        const label = (days.length - 1 - i) % 2 === 0 ? getWeekdayShort(k).slice(0, 2) : "";
        return `<div class="trend-col${k === today ? " is-today" : ""}" title="${escapeHtml(formatDateLabel(k))}: ${counts[i]} of ${total} checked in (${pct}%)">
          <div class="trend-bar tone-${tone}" style="height:${h}%"></div>
          <span>${label}</span>
        </div>`;
      }).join("")}
    </div>
    <div class="trend-legend">
      <span><i class="tone-low"></i>&lt;50%</span>
      <span><i class="tone-mid"></i>50-79%</span>
      <span><i class="tone-high"></i>80%+</span>
    </div>`;
}

function renderBestEmployees() {
  if (!elements.bestEmployees) return;
  const ym = todayKey().slice(0, 7);
  const ranked = state.employees.map((emp) => {
    const recs = state.attendance.filter((r) => r.uid === emp.uid && r.dateKey.startsWith(ym) && r.checkIn);
    const onTime = recs.filter((r) => shiftTiming(r, getShiftFor(r.uid, r.dateKey)).lateMins <= 0).length;
    const mins = recs.reduce((sum, r) => sum + (r.checkOut ? calcMinutes(r.checkIn, r.checkOut) || 0 : 0), 0);
    return { emp, days: recs.length, onTime, mins };
  }).filter((x) => x.days > 0)
    .sort((a, b) => b.onTime - a.onTime || b.days - a.days || b.mins - a.mins || String(a.emp.name).localeCompare(String(b.emp.name)));

  if (!ranked.length) {
    elements.bestEmployees.innerHTML = '<div class="empty-state">No check-ins yet this month.</div>';
    return;
  }
  const podium = [ranked[1], ranked[0], ranked[2]].filter(Boolean).map((x) => {
    const rank = ranked.indexOf(x) + 1;
    return `<button class="podium-item rank-${rank}" type="button" data-open-employee="${escapeHtml(x.emp.uid)}">
      <span class="podium-avatar">${avatarHtml(x.emp.name, rank === 1 ? "avatar-xl" : "avatar-lg")}<span class="rank-badge">${rank}</span></span>
      <strong>${escapeHtml(truncateText(x.emp.name, 16))}</strong>
      <span class="podium-score">${x.onTime}/${x.days} on time</span>
    </button>`;
  }).join("");
  const list = ranked.slice(3, 8).map((x, i) => `
    <button class="best-row" type="button" data-open-employee="${escapeHtml(x.emp.uid)}">
      <span class="best-rank">${i + 4}</span>
      ${avatarHtml(x.emp.name)}
      <span class="best-name"><strong>${escapeHtml(x.emp.name)}</strong><span>${escapeHtml(x.emp.role || x.emp.department || "")}</span></span>
      <span class="best-score">${x.onTime}<small>/${x.days} on time</small></span>
    </button>`).join("");
  elements.bestEmployees.innerHTML = `<div class="podium">${podium}</div>${list ? `<div class="best-list">${list}</div>` : ""}`;
  elements.bestEmployees.querySelectorAll("[data-open-employee]").forEach((b) => {
    b.addEventListener("click", () => openEmployeeDrawer(b.getAttribute("data-open-employee")));
  });
}

function editTimeButton(record) {
  if (state.role !== "super_admin") return "-";
  return `<button class="mini-btn" data-edit-time="${escapeHtml(record.dateKey)}|${escapeHtml(record.uid)}" type="button">Edit Time</button>`;
}

function attendanceRow(record) {
  const hours = record.checkIn && record.checkOut ? calcHours(record.checkIn, record.checkOut) : "-";
  const day = record.dateKey ? getWeekdayShort(record.dateKey) : "-";
  const shift = getShiftFor(record.uid, record.dateKey);
  const info = dayType(record, shift, record.dateKey, todayKey());
  const status = info.type || calcStatus(record);
  const pillClass = info.tone;
  return `<tr>
    <td data-label="Date">${escapeHtml(record.dateKey || "-")}</td>
    <td data-label="Day">${escapeHtml(day)}</td>
    <td data-label="Name">${escapeHtml(getEmployeeName(record.uid))}</td>
    <td data-label="UID">${escapeHtml(cardLabel(record.uid))}</td>
    <td data-label="Shift">${shiftCell(shift)}</td>
    <td data-label="Check In">${record.checkIn ? escapeHtml(formatTimeAmPm(record.checkIn)) : "-"}</td>
    <td data-label="Check Out">${record.checkOut ? escapeHtml(formatTimeAmPm(record.checkOut)) : "-"}</td>
    <td data-label="Late / Early">${timingCell(record, shift)}</td>
    <td data-label="Hours">${hours}</td>
    <td data-label="Status"><span class="pill ${pillClass}">${status}</span></td>
    <td data-label="Location">${locationCell(record)}</td>
    <td data-label="Actions">${editTimeButton(record)}</td>
  </tr>`;
}

function wireEditTimeButtons(container) {
  container.querySelectorAll("[data-edit-time]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [dateKey, uid] = btn.getAttribute("data-edit-time").split("|");
      openEditTimeModal(dateKey, uid);
    });
  });
}

function renderTodayAttendance() {
  const today = todayKey();
  const rows = state.attendance.filter((r) => r.dateKey === today).map(attendanceRow).join("");
  elements.todayAttendanceBody.innerHTML = rows || '<tr><td colspan="12" class="empty-state">No attendance records for today.</td></tr>';
  wireEditTimeButtons(elements.todayAttendanceBody);
}

function employeeRow(employee) {
  const deleteBtn = canManageLogins()
    ? `<button class="mini-btn" data-delete-employee="${escapeHtml(employee.uid)}" type="button">Delete</button>`
    : "";
  const assignBtn = !hasCard(employee.uid) && state.role === "super_admin"
    ? `<button class="mini-btn" data-give-card="${escapeHtml(employee.uid)}" type="button">Assign Card</button>`
    : "";
  const uidCell = hasCard(employee.uid)
    ? escapeHtml(employee.uid)
    : '<span class="pill warning">No card</span>';
  return `<tr>
    <td data-label="UID">${uidCell}</td>
    <td data-label="ID">${escapeHtml(employee.employeeId)}</td>
    <td data-label="Name"><strong>${escapeHtml(employee.name)}</strong></td>
    <td data-label="Branch">${escapeHtml(employee.branch || "-")}</td>
    <td data-label="Department">${escapeHtml(employee.department)}</td>
    <td data-label="Job Title">${escapeHtml(employee.role)}</td>
    <td data-label="Actions">
      <button class="mini-btn" data-view-employee="${escapeHtml(employee.uid)}" type="button">View</button>
      <button class="mini-btn" data-edit-employee="${escapeHtml(employee.uid)}" type="button">Edit</button>
      ${assignBtn}
      ${deleteBtn}
    </td>
  </tr>`;
}

function renderEmployeeTable() {
  const filtered = filterBySearch(state.employees, state.employeeSearch, ["uid", "employeeId", "name", "branch", "department", "role"]);
  elements.employeeTableBody.innerHTML = filtered.map(employeeRow).join("") || '<tr><td colspan="7" class="empty-state">No employees found.</td></tr>';

  elements.employeeTableBody.querySelectorAll("[data-view-employee]").forEach((btn) => {
    btn.addEventListener("click", () => openEmployeeDrawer(btn.getAttribute("data-view-employee")));
  });
  elements.employeeTableBody.querySelectorAll("[data-edit-employee]").forEach((btn) => {
    btn.addEventListener("click", () => fillEmployeeForm(btn.getAttribute("data-edit-employee")));
  });
  elements.employeeTableBody.querySelectorAll("[data-delete-employee]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.getAttribute("data-delete-employee");
      if (uid) openDeleteEmployeeModal(uid);
    });
  });
  elements.employeeTableBody.querySelectorAll("[data-give-card]").forEach((btn) => {
    btn.addEventListener("click", () => openAssignCardModal(btn.getAttribute("data-give-card")));
  });
}

function renderAttendanceEmployeeFilter() {
  if (!elements.attendanceEmployeeFilter) return;
  const sortedEmployees = [...state.employees].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const options = ['<option value="">All Employees</option>']
    .concat(sortedEmployees.map((e) => `<option value="${escapeHtml(e.uid)}" ${e.uid === state.attendanceEmployeeUid ? "selected" : ""}>${escapeHtml(e.name)}</option>`));
  elements.attendanceEmployeeFilter.innerHTML = options.join("");
}

function renderAttendanceTable() {
  renderAttendanceEmployeeFilter();

  const filtered = filterBySearch(
    state.attendance
      .filter((r) => isWithinDateRange(r.dateKey, state.attendanceFrom, state.attendanceTo))
      .filter((r) => !state.attendanceEmployeeUid || r.uid === state.attendanceEmployeeUid),
    state.attendanceSearch,
    ["dateKey", "employeeName", "uid"],
  );
  elements.attendanceTableBody.innerHTML = filtered.map(attendanceRow).join("") || '<tr><td colspan="12" class="empty-state">No attendance records match the filters.</td></tr>';
  wireEditTimeButtons(elements.attendanceTableBody);
}

function renderDrawer() {
  const employee = state.employees.find((e) => e.uid === state.selectedEmployeeUid);
  if (!employee) {
    elements.drawerEmployeeName.textContent = "Select an employee";
    elements.drawerSummary.innerHTML = '<div class="empty-state">Choose an employee to view details.</div>';
    elements.drawerAttendanceBody.innerHTML = '<tr><td colspan="9" class="empty-state">No employee selected.</td></tr>';
    elements.drawerMonthSummary.innerHTML = "";
    elements.drawerRemarkList.innerHTML = "";
    elements.drawerCalendarGrid.innerHTML = "";
    elements.drawerCalendarLabel.textContent = "-";
    return;
  }

  elements.drawerEmployeeName.textContent = employee.name;
  elements.drawerSummary.innerHTML = `
    <div class="setting-card"><span>UID</span><strong>${escapeHtml(cardLabel(employee.uid))}</strong></div>
    <div class="setting-card"><span>Employee ID</span><strong>${escapeHtml(employee.employeeId)}</strong></div>
    <div class="setting-card"><span>Branch</span><strong>${escapeHtml(employee.branch || "-")}</strong></div>
    <div class="setting-card"><span>Department</span><strong>${escapeHtml(employee.department)}</strong></div>
    <div class="setting-card"><span>Job Title</span><strong>${escapeHtml(employee.role)}</strong></div>
    <div class="setting-card"><span>Phone</span><strong>${escapeHtml(employee.phone || "-")}</strong></div>
    <div class="setting-card"><span>Default Shift</span><strong>${escapeHtml(formatShift(getEmployeeShift(employee)))}</strong></div>
  `;

  renderDrawerCalendar(employee);

  // Remarks
  const empRemarks = state.remarks.filter((r) => r.uid === employee.uid);
  elements.drawerRemarkList.innerHTML = empRemarks.length
    ? empRemarks.map((r) => `<div class="remark-item">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>${escapeHtml(r.date || "-")}</strong>
          <button class="mini-btn" data-delete-remark="${escapeHtml(r.id)}" type="button" style="padding:4px 8px;font-size:0.75rem;">Delete</button>
        </div>
        ${escapeHtml(r.text)}
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
  // Nothing picked = all time; never pre-select a month the filter is not actually using.
  const currentMonth = state.drawerMonth || "";
  elements.drawerMonthSelect.innerHTML = '<option value="">All Time</option>' + months.map((m) => `<option value="${escapeHtml(m)}" ${m === currentMonth ? "selected" : ""}>${escapeHtml(getMonthLabel(m))}</option>`).join("");

  // Filter records
  let filtered = empRecords;
  if (state.drawerMonth) {
    filtered = filtered.filter((r) => r.dateKey && r.dateKey.startsWith(state.drawerMonth));
  }
  if (state.drawerFrom || state.drawerTo) {
    filtered = filtered.filter((r) => isWithinDateRange(r.dateKey, state.drawerFrom, state.drawerTo));
  }

  // Month summary
  const summaryRecords = filtered; // same month / date range as the table below

  const totalDays = summaryRecords.length;
  const checkedOutDays = summaryRecords.filter((r) => r.checkIn && r.checkOut).length;
  const presentDays = summaryRecords.filter((r) => r.checkIn).length;
  let totalMins = 0;
  let lateDays = 0;
  let totalLateMins = 0;
  summaryRecords.forEach((r) => {
    if (r.checkIn && r.checkOut) totalMins += calcMinutes(r.checkIn, r.checkOut);
    const late = shiftTiming(r, getShiftFor(r.uid, r.dateKey)).lateMins;
    if (late > 0) {
      lateDays += 1;
      totalLateMins += late;
    }
  });
  const avgMins = checkedOutDays > 0 ? Math.round(totalMins / checkedOutDays) : 0;

  elements.drawerMonthSummary.innerHTML = `
    <div class="month-stat"><span>Total Days</span><strong>${totalDays}</strong></div>
    <div class="month-stat"><span>Present</span><strong>${presentDays}</strong></div>
    <div class="month-stat"><span>Completed</span><strong>${checkedOutDays}</strong></div>
    <div class="month-stat"><span>Total Hours</span><strong>${Math.floor(totalMins / 60)}h ${totalMins % 60}m</strong></div>
    <div class="month-stat"><span>Avg / Day</span><strong>${Math.floor(avgMins / 60)}h ${avgMins % 60}m</strong></div>
    <div class="month-stat"><span>Late Days</span><strong>${lateDays}</strong></div>
    <div class="month-stat"><span>Total Late</span><strong>${totalLateMins ? formatDuration(totalLateMins) : "0 min"}</strong></div>
  `;

  // Table
  const rows = filtered.map((record) => {
    const hours = record.checkIn && record.checkOut ? calcHours(record.checkIn, record.checkOut) : "-";
    const shift = getShiftFor(record.uid, record.dateKey);
    const info = dayType(record, shift, record.dateKey, todayKey());
    const status = info.type || calcStatus(record);
    const pillClass = info.tone;
    return `<tr>
      <td data-label="Date">${escapeHtml(record.dateKey)}</td>
      <td data-label="Shift">${shiftCell(shift)}</td>
      <td data-label="Check In">${record.checkIn ? escapeHtml(formatTimeAmPm(record.checkIn)) : "-"}</td>
      <td data-label="Check Out">${record.checkOut ? escapeHtml(formatTimeAmPm(record.checkOut)) : "-"}</td>
      <td data-label="Late / Early">${timingCell(record, shift)}</td>
      <td data-label="Hours">${hours}</td>
      <td data-label="Status"><span class="pill ${pillClass}">${status}</span></td>
      <td data-label="Location">${locationCell(record)}</td>
      <td data-label="Actions">${editTimeButton(record)}</td>
    </tr>`;
  }).join("");

  elements.drawerAttendanceBody.innerHTML = rows || '<tr><td colspan="9" class="empty-state">No attendance records found.</td></tr>';
  wireEditTimeButtons(elements.drawerAttendanceBody);
}

const CALENDAR_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function renderDrawerCalendar(employee) {
  const ym = state.calendarMonth || todayKey().slice(0, 7);
  elements.drawerCalendarLabel.textContent = getMonthLabel(ym);

  const empRecords = state.attendance.filter((r) => r.uid === employee.uid);
  const empRemarks = state.remarks.filter((r) => r.uid === employee.uid);
  const today = todayKey();
  const total = daysInMonth(ym);
  const startWeekday = firstWeekdayOfMonth(ym);

  let html = CALENDAR_WEEKDAYS.map((d) => `<div class="calendar-weekday">${d}</div>`).join("");
  for (let i = 0; i < startWeekday; i++) {
    html += '<div class="calendar-cell is-empty"></div>';
  }

  for (let day = 1; day <= total; day++) {
    const dateKey = `${ym}-${String(day).padStart(2, "0")}`;
    const record = empRecords.find((r) => r.dateKey === dateKey);
    const remark = empRemarks.find((r) => r.date === dateKey);
    const dayInfo = dayType(record, getShiftFor(employee.uid, dateKey), dateKey, today);
    const status = dayInfo.type;
    const pillClass = dayInfo.tone;
    const cellClasses = ["calendar-cell"];
    if (dateKey === today) cellClasses.push("is-today");
    if (remark) cellClasses.push("has-remark");

    const checkInTime = record?.checkIn ? formatTimeAmPm(record.checkIn) : "";
    const checkOutTime = record?.checkOut ? formatTimeAmPm(record.checkOut) : "";
    const shift = getShiftFor(employee.uid, dateKey);
    const timing = shiftTiming(record, shift);

    const tooltipParts = [`${status || "Upcoming"} | Shift: ${formatShift(shift)}${shift.custom ? " (custom)" : ""}`];
    if (dayInfo.deductionMins) tooltipParts.push(`Deduction: ${formatDuration(dayInfo.deductionMins)}`);
    if (checkInTime) tooltipParts.push(`Check-in: ${checkInTime} (${inRemark(timing)})`);
    if (checkOutTime) tooltipParts.push(`Check-out: ${checkOutTime} (${outRemark(timing)})`);
    if (remark) tooltipParts.push(`Remark: ${remark.text}`);

    html += `<div class="${cellClasses.join(" ")}" data-cal-date="${dateKey}" title="${escapeHtml(tooltipParts.join(" | "))}">
      <div class="cal-cell-head">
        <span class="cal-day-num">${day}</span>
        ${status ? `<span class="cal-status-dot ${pillClass}"></span>` : ""}
      </div>
      ${shift.custom ? `<span class="cal-shift-tag">${escapeHtml(formatShift(shift))}</span>` : ""}
      ${checkInTime ? `<span class="cal-time cal-time-in">In ${checkInTime}</span>` : ""}
      ${timing.lateMins > 0 ? `<span class="cal-late-badge">${escapeHtml(formatDuration(timing.lateMins))} late</span>` : ""}
      ${checkOutTime ? `<span class="cal-time cal-time-out">Out ${checkOutTime}</span>` : ""}
      ${remark ? `<span class="cal-remark-badge">${escapeHtml(truncateText(remark.text, 14))}</span>` : ""}
    </div>`;
  }

  elements.drawerCalendarGrid.innerHTML = html;

  elements.drawerCalendarGrid.querySelectorAll("[data-cal-date]").forEach((cell) => {
    cell.addEventListener("click", () => {
      elements.drawerRemarkDate.value = cell.getAttribute("data-cal-date");
      elements.drawerRemarkInput.focus();
    });
  });
}

function getWeekdayShort(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
}

function formatDateLabel(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${weekdays[date.getDay()]}, ${months[m - 1]} ${d} ${y}`;
}

function renderCompanyCalendar() {
  if (!elements.calGrid) return;
  const ym = state.calendarPageMonth || todayKey().slice(0, 7);
  elements.calLabel.textContent = getMonthLabel(ym);

  const today = todayKey();
  const total = daysInMonth(ym);
  const startWeekday = firstWeekdayOfMonth(ym);
  const MAX_NAMES = 3;

  let html = CALENDAR_WEEKDAYS.map((d) => `<div class="calendar-weekday">${d}</div>`).join("");
  for (let i = 0; i < startWeekday; i++) {
    html += '<div class="calendar-cell is-empty"></div>';
  }

  const MAX_REMARKS = 2;

  for (let day = 1; day <= total; day++) {
    const dateKey = `${ym}-${String(day).padStart(2, "0")}`;
    const dayRecords = state.attendance.filter((r) => r.dateKey === dateKey && r.checkIn);
    const lateCount = dayRecords.filter((r) => shiftTiming(r, getShiftFor(r.uid, dateKey)).lateMins > 0).length;
    const names = dayRecords.map((r) => getEmployeeName(r.uid));
    const shown = names.slice(0, MAX_NAMES);
    const extra = names.length - shown.length;

    const dayRemarks = state.remarks.filter((r) => r.date === dateKey);
    const remarkLines = dayRemarks.map((r) => `${getEmployeeName(r.uid)}: ${r.text}`);
    const shownRemarks = remarkLines.slice(0, MAX_REMARKS);
    const extraRemarks = remarkLines.length - shownRemarks.length;

    const cellClasses = ["calendar-cell", "company-cal-cell"];
    if (dateKey === today) cellClasses.push("is-today");
    if (dateKey === state.calendarSelectedDate) cellClasses.push("is-selected");
    if (names.length) cellClasses.push("has-people");
    if (dayRemarks.length) cellClasses.push("has-remark");

    const tooltipParts = [];
    if (names.length) tooltipParts.push(names.join(", "));
    if (remarkLines.length) tooltipParts.push(remarkLines.join(" | "));

    html += `<div class="${cellClasses.join(" ")}" data-cal-date="${dateKey}" title="${escapeHtml(tooltipParts.join(" — "))}">
      <span class="cal-day-num">${day}</span>
      ${lateCount ? `<span class="cal-late-badge">${lateCount} late</span>` : ""}
      ${names.length ? `<div class="cal-avatar-stack">
        ${shown.map((n) => avatarHtml(n, "avatar-sm")).join("")}
        ${extra > 0 ? `<span class="avatar avatar-sm avatar-more">+${extra}</span>` : ""}
      </div>` : ""}
      ${remarkLines.length ? `<div class="cal-name-list">
        ${shownRemarks.map((line) => `<span class="cal-remark-badge">${escapeHtml(truncateText(line, 16))}</span>`).join("")}
        ${extraRemarks > 0 ? `<span class="cal-remark-badge cal-name-more">+${extraRemarks}</span>` : ""}
      </div>` : ""}
    </div>`;
  }

  elements.calGrid.innerHTML = html;

  elements.calGrid.querySelectorAll("[data-cal-date]").forEach((cell) => {
    cell.addEventListener("click", () => {
      location.hash = `#calendar/${cell.getAttribute("data-cal-date")}`;
    });
  });
}

function renderCalendarSidePanel() {
  if (!elements.calSideList) return;
  const dateKey = state.calendarSelectedDate;

  if (!dateKey) {
    elements.calSideDateTag.textContent = "Select a date";
    elements.calSideDateLabel.textContent = "-";
    elements.calSideList.innerHTML = '<div class="empty-state">Click a day on the calendar to see who was present.</div>';
    return;
  }

  const dayRemarks = state.remarks.filter((r) => r.date === dateKey);
  const today = todayKey();

  elements.calSideDateTag.textContent = "Attendance & Shifts";
  elements.calSideDateLabel.textContent = formatDateLabel(dateKey);

  // Every employee for this day: their shift, and how their in / out compares with it.
  const sortedEmployees = [...state.employees].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const attendanceHtml = sortedEmployees.length
    ? sortedEmployees.map((emp) => {
      const r = state.attendance.find((rec) => rec.dateKey === dateKey && rec.uid === emp.uid && rec.checkIn);
      const shift = getShiftFor(emp.uid, dateKey);
      let times;
      if (r) {
        times = `<span class="cal-time cal-time-in">In ${formatTimeAmPm(r.checkIn)}</span>
          ${r.checkOut ? `<span class="cal-time cal-time-out">Out ${formatTimeAmPm(r.checkOut)}</span>` : ""}
          ${timingCell(r, shift)}`;
      } else {
        times = `<span class="pill ${dateKey < today ? "error" : ""}">${dateKey < today ? "Absent" : dateKey === today ? "Not in yet" : "Scheduled"}</span>`;
      }
      return `
      <div class="cal-side-item">
        <div>
          <strong>${escapeHtml(emp.name)}</strong>
          <span class="cal-side-sub">${escapeHtml(emp.employeeId || "")} &bull; ${escapeHtml(formatShift(shift))}${shift.custom ? " (custom)" : ""}</span>
        </div>
        <div class="cal-side-times">${times}</div>
      </div>`;
    }).join("")
    : '<div class="empty-state" style="font-size:0.85rem;">No employees yet.</div>';

  const remarksHtml = dayRemarks.length
    ? `<div class="drawer-section-title" style="margin-top:16px;">Remarks</div>${dayRemarks.map((r) => `
      <div class="cal-side-item">
        <div>
          <strong>${escapeHtml(getEmployeeName(r.uid))}</strong>
          <span class="cal-side-sub">${escapeHtml(r.text)}</span>
        </div>
      </div>
    `).join("")}`
    : "";

  elements.calSideList.innerHTML = attendanceHtml + remarksHtml;
}

// ---- UNASSIGNED CARDS (live assign) ----

function renderUnknownCards() {
  if (!elements.unassignedList) return;
  const cards = state.unknownCards.filter((c) => !state.employees.some((e) => e.uid === c.uid));
  elements.unassignedCount.textContent = cards.length ? `${cards.length} waiting` : "None waiting";
  elements.unassignedCount.className = `status-pill${cards.length ? " accent" : ""}`;
  elements.unassignedNavBadge.textContent = String(cards.length);
  elements.unassignedNavBadge.classList.toggle("hidden", !cards.length);
  elements.unassignedList.innerHTML = cards.length
    ? cards.map((c) => `
      <div class="unassigned-card">
        <div class="unassigned-card-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 10h4M7 14h7"/><circle cx="17" cy="10" r="1.5"/></svg>
        </div>
        <div class="unassigned-card-body">
          <strong class="mono">${escapeHtml(c.uid)}</strong>
          <span>Tapped ${escapeHtml(formatWhen(c.lastScanAt))}${c.readerName ? ` &bull; ${escapeHtml(c.readerName)}` : ""}</span>
        </div>
        <div class="unassigned-card-actions">
          <button class="primary-btn" data-assign-card="${escapeHtml(c.uid)}" type="button">Assign</button>
          <button class="mini-btn" data-dismiss-card="${escapeHtml(c.uid)}" type="button">Dismiss</button>
        </div>
      </div>`).join("")
    : `<div class="unassigned-empty">
        <strong>No unassigned cards</strong>
        <span>Tap a new card on any approved reader. It shows up here instantly, ready to assign.</span>
      </div>`;
  elements.unassignedList.querySelectorAll("[data-assign-card]").forEach((btn) => {
    btn.addEventListener("click", () => startAssignCard(btn.getAttribute("data-assign-card")));
  });
  elements.unassignedList.querySelectorAll("[data-dismiss-card]").forEach((btn) => {
    btn.addEventListener("click", () => dismissUnknownCard(btn.getAttribute("data-dismiss-card")));
  });
}

async function recordUnknownCard(uid, source) {
  const card = { uid, lastScanAt: new Date().toISOString(), readerId: "dashboard", readerName: `Dashboard (${source})`.slice(0, 40) };
  if (!state.db) {
    state.unknownCards = [card, ...state.unknownCards.filter((c) => c.uid !== uid)];
    renderUnknownCards();
    return;
  }
  try {
    await state.db.collection("unknownCards").doc(uid).set(card);
  } catch (error) {
    handleFirestoreError(error);
  }
}

async function dismissUnknownCard(uid) {
  state.unknownCards = state.unknownCards.filter((c) => c.uid !== uid);
  renderUnknownCards();
  if (!state.db) return;
  try {
    await state.db.collection("unknownCards").doc(uid).delete();
  } catch (error) {
    handleFirestoreError(error);
  }
}

function startAssignCard(uid) {
  hideCardToast();
  clearEmployeeForm();
  state.assigningCardUid = uid;
  elements.employeeUid.value = uid;
  elements.employeeUid.readOnly = true;
  const card = state.unknownCards.find((c) => c.uid === uid);
  const seen = card ? `Tapped ${escapeHtml(formatWhen(card.lastScanAt))}${card.readerName ? ` at ${escapeHtml(card.readerName)}` : ""}. ` : "";
  elements.assignBanner.innerHTML = `<strong>Assigning card <span class="mono">${escapeHtml(uid)}</span></strong>
    <span>${seen}Fill in the employee details and their shift, then Save.</span>`;
  elements.assignBanner.classList.remove("hidden");
  location.hash = "#employees/add";
  setTimeout(() => elements.employeeId.focus(), 50);
}

let cardToastUid = "";
let cardToastTimer = null;

function showCardToast(uid, readerName) {
  if (!elements.cardToast || state.employees.some((e) => e.uid === uid)) return;
  cardToastUid = uid;
  elements.cardToastText.innerHTML = `New card <span class="mono">${escapeHtml(uid)}</span> tapped${readerName ? ` at ${escapeHtml(readerName)}` : ""}`;
  elements.cardToast.classList.remove("hidden");
  clearTimeout(cardToastTimer);
  cardToastTimer = setTimeout(hideCardToast, 20000);
}

function hideCardToast() {
  if (elements.cardToast) elements.cardToast.classList.add("hidden");
  clearTimeout(cardToastTimer);
}

// ---- SHIFT EDITOR (Calendar side panel) ----

function renderShiftEditor() {
  if (!elements.shiftEmployeeSelect) return;
  const current = elements.shiftEmployeeSelect.value;
  const sorted = [...state.employees].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  elements.shiftEmployeeSelect.innerHTML = sorted.length
    ? sorted.map((e) => `<option value="${escapeHtml(e.uid)}">${escapeHtml(e.name)} (${escapeHtml(e.employeeId || e.uid)})</option>`).join("")
    : '<option value="">No employees yet</option>';
  if (current && sorted.some((e) => e.uid === current)) elements.shiftEmployeeSelect.value = current;

  const dateKey = state.calendarSelectedDate || todayKey();
  if (!elements.shiftFromDate.value || state.shiftEditorDate !== dateKey) {
    elements.shiftFromDate.value = dateKey;
    elements.shiftToDate.value = dateKey;
    state.shiftEditorDate = dateKey;
    syncShiftEditorTimes();
  }
}

function setPresetFromTimes(selectEl, start, end) {
  const key = `${start}-${end}`;
  selectEl.value = Array.from(selectEl.options).some((o) => o.value === key) ? key : "custom";
}

// Show the shift that currently applies to the chosen employee on the "From" date.
function syncShiftEditorTimes() {
  const uid = elements.shiftEmployeeSelect.value;
  if (!uid) return;
  const shift = getShiftFor(uid, elements.shiftFromDate.value || todayKey());
  elements.shiftStartInput.value = shift.start;
  elements.shiftEndInput.value = shift.end;
  setPresetFromTimes(elements.shiftPresetSelect, shift.start, shift.end);
  elements.shiftHint.textContent = shift.custom ? "This day already has a custom shift." : "Currently the employee's default shift.";
}

function dateRangeKeys(from, to) {
  const keys = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const cur = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  while (cur <= end && keys.length < 400) {
    keys.push(todayKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return keys;
}

async function saveShiftOverride(reset) {
  const uid = elements.shiftEmployeeSelect.value;
  const from = elements.shiftFromDate.value;
  const to = elements.shiftToDate.value || from;
  const start = elements.shiftStartInput.value;
  const end = elements.shiftEndInput.value;
  if (!uid || !from) {
    elements.shiftHint.textContent = "Choose an employee and a date.";
    return;
  }
  if (to < from) {
    elements.shiftHint.textContent = "'To' must be on or after 'From'.";
    return;
  }
  if (!reset && (!validShiftTime(start) || !validShiftTime(end) || start === end)) {
    elements.shiftHint.textContent = "Enter a valid start and end time.";
    return;
  }
  const employee = state.employees.find((e) => e.uid === uid);
  if (!employee) return;

  const days = dateRangeKeys(from, to);
  const overrides = { ...(employee.shiftOverrides || {}) };
  days.forEach((d) => {
    if (reset) delete overrides[d];
    else overrides[d] = { start, end };
  });

  try {
    if (state.db) {
      const FieldPath = window.firebase.firestore.FieldPath;
      const FieldValue = window.firebase.firestore.FieldValue;
      const args = [];
      days.forEach((d) => {
        args.push(new FieldPath("shiftOverrides", d), reset ? FieldValue.delete() : { start, end });
      });
      await state.db.collection("employees").doc(uid).update(...args);
    }
    employee.shiftOverrides = overrides;
    const label = days.length === 1 ? formatDateLabel(from) : `${days.length} days (${from} to ${to})`;
    elements.shiftHint.textContent = reset
      ? `${employee.name}: back to default shift on ${label}.`
      : `${employee.name}: ${formatShift({ start, end })} on ${label}.`;
    renderAll();
  } catch (error) {
    handleFirestoreError(error);
    elements.shiftHint.textContent = "Could not save the shift. Check your permissions and try again.";
  }
}

// ---- SHEET EXPORT ----

const SHEET_HEADER = [
  "Date", "Day", "Employee ID", "Employee Name", "Branch", "Department",
  "Shift", "Shift Type", "Check In", "Check Out", "Status",
  "Late (min)", "Arrival", "Early Leave (min)", "Overtime (min)", "Departure", "Worked Hours",
  "Day Type", "Deduction (min)", "Remarks",
];

// One row per employee per day in [from, to] (future days skipped), so absent days show up too.
function buildSheetRows(uids, from, to) {
  const today = todayKey();
  const days = dateRangeKeys(from, to).filter((d) => d <= today);
  const employees = uids
    .map((uid) => state.employees.find((e) => e.uid === uid))
    .filter(Boolean)
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const rows = [];
  days.forEach((dateKey) => {
    employees.forEach((emp) => {
      const rec = state.attendance.find((r) => r.dateKey === dateKey && r.uid === emp.uid && r.checkIn);
      const shift = getShiftFor(emp.uid, dateKey);
      const info = dayType(rec, shift, dateKey, today);
      const timing = info.timing;
      const remarks = state.remarks.filter((r) => r.uid === emp.uid && r.date === dateKey).map((r) => r.text).join("; ");
      let status = "Absent";
      if (rec) status = rec.checkOut ? "Checked Out" : "Present";
      else if (dateKey === today) status = "Not in yet";
      rows.push([
        dateKey,
        getWeekdayShort(dateKey),
        emp.employeeId || "",
        emp.name || "",
        emp.branch || "",
        emp.department || "",
        formatShift(shift),
        shift.custom ? "Custom" : "Default",
        rec ? formatTimeAmPm(rec.checkIn) : "",
        rec?.checkOut ? formatTimeAmPm(rec.checkOut) : "",
        status,
        timing.hasIn ? timing.lateMins : "",
        inRemark(timing),
        timing.hasOut ? timing.earlyLeaveMins : "",
        timing.hasOut ? timing.overtimeMins : "",
        outRemark(timing),
        rec?.checkIn && rec?.checkOut ? calcHours(rec.checkIn, rec.checkOut) : "",
        info.type,
        info.deductionMins,
        remarks,
      ]);
    });
  });
  return rows;
}

function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // keep spreadsheet apps from treating text as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadSheet(uids, from, to, label) {
  const today = todayKey();
  const rangeFrom = from || `${today.slice(0, 7)}-01`;
  const rangeTo = to || today;
  const rows = buildSheetRows(uids, rangeFrom, rangeTo);
  if (!rows.length) {
    alert("Nothing to download for this selection.");
    return;
  }
  const csv = [SHEET_HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeLabel = String(label).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "attendance";
  a.href = url;
  a.download = `attendance_${safeLabel}_${rangeFrom}_to_${rangeTo}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderScanFeed() {
  if (!state.scanFeed.length) {
    elements.scanFeed.innerHTML = '<div class="feed-item"><strong>No scan activity yet</strong><span>Connect the ESP32 or run a demo scan.</span></div>';
    return;
  }
  elements.scanFeed.innerHTML = state.scanFeed.slice(0, 6).map((entry) => `
    <div class="feed-item">
      <strong>${escapeHtml(entry.name || "Unknown")} <span class="pill ${entry.type === "error" ? "error" : entry.type === "CHECK_OUT" ? "out" : entry.type === "CHECK_IN" ? "info" : "done"}">${escapeHtml(entry.type)}</span></strong>
      <span>${escapeHtml(entry.message)}</span>
      <span>${escapeHtml(entry.uid || "No UID")} &bull; ${escapeHtml(entry.time)} &bull; ${escapeHtml(entry.source)}</span>
    </div>
  `).join("");
}

function renderAll() {
  if (!state.user) return;
  renderStatusBadges();
  renderLiveOutput();
  renderMetrics();
  renderTodayAttendance();
  renderEmployeeTable();
  renderAttendanceTable();
  renderDrawer();
  renderScanFeed();
  renderCompanyCalendar();
  renderCalendarSidePanel();
  renderShiftEditor();
  renderUnknownCards();
  if (canManageLogins()) {
    renderUserEmployeeOptions();
    renderUsersTable();
  }
}

// ---- ACTIONS ----

function clearEmployeeForm() {
  state.editingEmployeeUid = "";
  state.assigningCardUid = "";
  if (elements.assignBanner) elements.assignBanner.classList.add("hidden");
  elements.employeeUid.readOnly = false;
  elements.employeeForm.reset();
  elements.employeeShiftStart.value = DEFAULT_SHIFT.start;
  elements.employeeShiftEnd.value = DEFAULT_SHIFT.end;
  setPresetFromTimes(elements.employeeShiftPreset, DEFAULT_SHIFT.start, DEFAULT_SHIFT.end);
  elements.employeeUid.focus();
}

function fillEmployeeForm(uid) {
  const emp = state.employees.find((e) => e.uid === uid);
  if (!emp) return;
  // The card UID is the employee's database key (attendance and remarks point at it), so it can't be
  // changed while editing; typing a different one would create a second employee instead.
  state.editingEmployeeUid = emp.uid;
  state.assigningCardUid = "";
  elements.assignBanner.classList.add("hidden");
  elements.employeeUid.readOnly = true;
  elements.employeeUid.value = emp.uid;
  elements.employeeId.value = emp.employeeId || "";
  elements.employeeName.value = emp.name || "";
  elements.employeeBranch.value = emp.branch || "";
  elements.employeeDepartment.value = emp.department || "";
  elements.employeeRole.value = emp.role || "";
  elements.employeePhone.value = emp.phone || "";
  const shift = getEmployeeShift(emp);
  elements.employeeShiftStart.value = shift.start;
  elements.employeeShiftEnd.value = shift.end;
  setPresetFromTimes(elements.employeeShiftPreset, shift.start, shift.end);
  location.hash = "#employees/add";
}

function openEmployeeDrawer(uid) {
  state.selectedEmployeeUid = uid;
  state.drawerFrom = "";
  state.drawerTo = "";
  state.drawerMonth = "";
  state.calendarMonth = todayKey().slice(0, 7);
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
    if (idx >= 0) state.employees[idx] = { ...state.employees[idx], ...employee };
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

// Firestore batches hold at most 500 writes; long attendance histories need several.
async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = state.db.batch();
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
}

async function docsWhereUid(collection, uid) {
  return (await state.db.collection(collection).where("uid", "==", uid).get()).docs;
}

// Employee Portal logins linked to this employee.
async function linkedLoginDocs(uid) {
  if (!canManageLogins()) return [];
  return (await state.db.collection("users").where("employeeUid", "==", uid).get()).docs;
}

// Delete an employee.
//  super_admin: everything - profile, attendance, remarks, shift changes (stored on the profile),
//               linked Employee Portal logins and any waiting "unassigned card" entry.
//  hr:          profile + linked logins; the attendance history stays (only super_admin may delete it).
// Either way the card is then free: tap it at a reader and it shows up as an unassigned card.
async function deleteEmployee(uid) {
  if (!canManageLogins()) return;
  if (!state.db) {
    state.employees = state.employees.filter((e) => e.uid !== uid);
    if (state.role === "super_admin") state.attendance = state.attendance.filter((e) => e.uid !== uid);
    state.remarks = state.remarks.filter((e) => e.uid !== uid);
    renderAll();
    return;
  }
  try {
    const ops = [];
    if (state.role === "super_admin") {
      (await docsWhereUid("attendance", uid)).forEach((d) => ops.push((b) => b.delete(d.ref)));
    }
    (await docsWhereUid("remarks", uid)).forEach((d) => ops.push((b) => b.delete(d.ref)));
    (await linkedLoginDocs(uid))
      .filter((d) => d.data().role === "employee")
      .forEach((d) => ops.push((b) => b.delete(d.ref)));
    if (hasCard(uid)) ops.push((b) => b.delete(state.db.collection("unknownCards").doc(uid)));
    ops.push((b) => b.delete(state.db.collection("employees").doc(uid)));
    await commitInChunks(ops);
  } catch (error) {
    handleFirestoreError(error);
    throw error;
  }
}

// Move an employee and everything that points at them from one key to another (super_admin only):
//   card -> NOCARD-...   "Remove card only": the card becomes free, nothing is lost
//   NOCARD-... -> card   "Assign card": give a card-less employee a (new) card
// New copies are written first and the old ones deleted after, so an interruption never loses data.
async function rekeyEmployee(oldUid, newUid) {
  if (state.role !== "super_admin") throw new Error("Only a Super Admin can change an employee's card.");
  const emp = state.employees.find((e) => e.uid === oldUid);
  if (!emp) throw new Error("Employee not found.");
  if (state.employees.some((e) => e.uid === newUid)) throw new Error(`Card ${newUid} already belongs to another employee.`);

  if (!state.db) {
    emp.uid = newUid;
    state.attendance.forEach((r) => { if (r.uid === oldUid) r.uid = newUid; });
    state.remarks.forEach((r) => { if (r.uid === oldUid) r.uid = newUid; });
    renderAll();
    return;
  }

  const db = state.db;
  const attendance = await docsWhereUid("attendance", oldUid);
  const remarks = await docsWhereUid("remarks", oldUid);
  const logins = await linkedLoginDocs(oldUid);
  const { uid: _old, ...profile } = emp;

  const writes = [(b) => b.set(db.collection("employees").doc(newUid), { ...profile, uid: newUid })];
  attendance.forEach((d) => {
    const data = d.data();
    const newId = `${data.dateKey || d.id.split("_")[0]}_${newUid}`;
    writes.push((b) => b.set(db.collection("attendance").doc(newId), { ...data, uid: newUid }));
  });
  remarks.forEach((d) => writes.push((b) => b.update(d.ref, { uid: newUid })));
  logins.forEach((d) => writes.push((b) => b.update(d.ref, { employeeUid: newUid })));
  await commitInChunks(writes);

  const deletes = attendance.map((d) => (b) => b.delete(d.ref));
  deletes.push((b) => b.delete(db.collection("employees").doc(oldUid)));
  if (hasCard(newUid)) deletes.push((b) => b.delete(db.collection("unknownCards").doc(newUid)));
  await commitInChunks(deletes);
}

// Attendance / remarks still stored under a card that no employee owns (left by an HR delete).
function orphanCountFor(uid) {
  return state.attendance.filter((r) => r.uid === uid).length + state.remarks.filter((r) => r.uid === uid).length;
}

async function clearOrphanHistory(uid) {
  if (!state.db) {
    state.attendance = state.attendance.filter((r) => r.uid !== uid);
    state.remarks = state.remarks.filter((r) => r.uid !== uid);
    return;
  }
  const ops = [];
  (await docsWhereUid("attendance", uid)).forEach((d) => ops.push((b) => b.delete(d.ref)));
  (await docsWhereUid("remarks", uid)).forEach((d) => ops.push((b) => b.delete(d.ref)));
  await commitInChunks(ops);
}

// ---- Delete / Remove card dialog ----
function openDeleteEmployeeModal(uid) {
  const emp = state.employees.find((e) => e.uid === uid);
  if (!emp) return;
  state.deleteEmployeeUid = uid;
  const superAdmin = state.role === "super_admin";
  elements.deleteEmpTag.textContent = `${emp.employeeId || ""} - ${cardLabel(emp.uid)}`;
  elements.deleteEmpTitle.textContent = `Delete ${emp.name}?`;
  elements.removeCardOnlyBtn.classList.toggle("hidden", !superAdmin || !hasCard(uid));
  elements.deleteEverythingBtn.querySelector("strong").textContent = superAdmin ? "Delete everything" : "Delete employee";
  elements.deleteEverythingText.textContent = superAdmin
    ? "Deletes the employee, all attendance, remarks, shift changes and their Employee Portal login. Cannot be undone."
    : "Deletes the employee and their Employee Portal login. The attendance history is kept; only a Super Admin can delete it.";
  elements.deleteEmpHint.textContent = "";
  setDeleteModalBusy(false);
  elements.deleteEmpBackdrop.classList.remove("hidden");
  elements.deleteEmpModal.classList.remove("hidden");
}

function closeDeleteEmployeeModal() {
  state.deleteEmployeeUid = "";
  elements.deleteEmpBackdrop.classList.add("hidden");
  elements.deleteEmpModal.classList.add("hidden");
}

function setDeleteModalBusy(busy) {
  elements.removeCardOnlyBtn.disabled = busy;
  elements.deleteEverythingBtn.disabled = busy;
}

async function runDeleteAction(action) {
  const uid = state.deleteEmployeeUid;
  const emp = state.employees.find((e) => e.uid === uid);
  if (!emp) return;
  if (action === "all" && !confirm(`Delete ${emp.name} and ${state.role === "super_admin" ? "ALL of their data" : "their profile"}? This cannot be undone.`)) return;
  setDeleteModalBusy(true);
  elements.deleteEmpHint.textContent = action === "all" ? "Deleting..." : "Removing card...";
  try {
    if (action === "card") {
      await rekeyEmployee(uid, `${NO_CARD_PREFIX}${Date.now().toString(36).toUpperCase()}`);
      state.liveOutput = { status: "success", message: `Card ${uid} removed from ${emp.name}. It can now be assigned to someone else.` };
    } else {
      await deleteEmployee(uid);
      state.liveOutput = { status: "success", message: `${emp.name} deleted. Card ${uid} is free.` };
    }
    if (state.selectedEmployeeUid === uid) closeEmployeeDrawer();
    closeDeleteEmployeeModal();
    alert(state.liveOutput.message);
  } catch (error) {
    elements.deleteEmpHint.textContent = error?.message || "Could not finish. Please try again.";
    setDeleteModalBusy(false);
  }
}

// ---- Assign card dialog (employee with no card) ----
function openAssignCardModal(uid) {
  const emp = state.employees.find((e) => e.uid === uid);
  if (!emp || state.role !== "super_admin") return;
  state.assignCardEmployeeUid = uid;
  elements.assignCardTitle.textContent = `Assign a card to ${emp.name}`;
  elements.assignCardInput.value = "";
  const waiting = state.unknownCards.filter((c) => !state.employees.some((e) => e.uid === c.uid));
  elements.assignCardOptions.innerHTML = waiting
    .map((c) => `<option value="${escapeHtml(c.uid)}">${escapeHtml(c.readerName ? `Tapped at ${c.readerName}` : "Waiting card")}</option>`)
    .join("");
  elements.assignCardHint.textContent = waiting.length
    ? `${waiting.length} tapped card(s) waiting - click the box to pick one, or type a UID.`
    : "Tap the card at a reader (it appears here), or type its UID.";
  elements.saveAssignCardBtn.disabled = false;
  elements.assignCardBackdrop.classList.remove("hidden");
  elements.assignCardModal.classList.remove("hidden");
  elements.assignCardInput.focus();
}

function closeAssignCardModal() {
  state.assignCardEmployeeUid = "";
  elements.assignCardBackdrop.classList.add("hidden");
  elements.assignCardModal.classList.add("hidden");
}

async function saveAssignCard() {
  const oldUid = state.assignCardEmployeeUid;
  const emp = state.employees.find((e) => e.uid === oldUid);
  const card = normalizeUid(elements.assignCardInput.value);
  if (!emp) return;
  if (card.length < 4) {
    elements.assignCardHint.textContent = "Enter the card UID (letters and numbers, at least 4).";
    return;
  }
  const owner = state.employees.find((e) => e.uid === card);
  if (owner) {
    elements.assignCardHint.textContent = `Card ${card} already belongs to ${owner.name}.`;
    return;
  }
  const leftovers = orphanCountFor(card);
  if (leftovers && !confirm(`Card ${card} still has ${leftovers} old record(s) from a deleted employee. Delete them so ${emp.name} starts clean?`)) return;
  elements.saveAssignCardBtn.disabled = true;
  elements.assignCardHint.textContent = "Assigning...";
  try {
    if (leftovers) await clearOrphanHistory(card);
    await rekeyEmployee(oldUid, card);
    if (state.selectedEmployeeUid === oldUid) closeEmployeeDrawer();
    closeAssignCardModal();
    alert(`Card ${card} assigned to ${emp.name}.`);
  } catch (error) {
    elements.assignCardHint.textContent = error?.message || "Could not assign the card.";
    elements.saveAssignCardBtn.disabled = false;
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
    // merge: never replace the whole document, so fields this dashboard doesn't know about
    // (e.g. values written by the Employee Portal) survive a scan or an Edit Time.
    await state.db.collection("attendance").doc(`${record.dateKey}_${record.uid}`).set(payload, { merge: true });
  } catch (error) {
    handleFirestoreError(error);
    throw error;
  }
}

// ---- EDIT TIME (Super Admin) ----

function openEditTimeModal(dateKey, uid) {
  if (state.role !== "super_admin") return;
  const record = state.attendance.find((r) => r.dateKey === dateKey && r.uid === uid);
  if (!record) return;
  state.editTimeRecord = { dateKey, uid };
  elements.editTimeTitle.textContent = `${getEmployeeName(uid)} — ${dateKey}`;
  elements.editTimeCheckIn.value = record.checkIn || "";
  elements.editTimeCheckOut.value = record.checkOut || "";
  elements.editTimeHint.textContent = "";
  elements.editTimeModal.classList.remove("hidden");
  elements.editTimeBackdrop.classList.remove("hidden");
}

function closeEditTimeModal() {
  state.editTimeRecord = null;
  elements.editTimeModal.classList.add("hidden");
  elements.editTimeBackdrop.classList.add("hidden");
}

async function saveEditTime() {
  if (!state.editTimeRecord || state.role !== "super_admin") return;
  const { dateKey, uid } = state.editTimeRecord;
  const checkIn = elements.editTimeCheckIn.value.trim();
  const checkOut = elements.editTimeCheckOut.value.trim();

  if (!checkIn && checkOut) {
    elements.editTimeHint.textContent = "Set a check-in time before setting check-out.";
    return;
  }

  const existing = state.attendance.find((r) => r.dateKey === dateKey && r.uid === uid) || {};
  const employee = state.employees.find((e) => e.uid === uid);
  const record = {
    ...existing,
    uid,
    dateKey,
    employeeId: existing.employeeId || employee?.employeeId,
    employeeName: existing.employeeName || employee?.name,
    checkIn: checkIn || null,
    checkOut: checkOut || null,
  };

  elements.saveEditTimeBtn.disabled = true;
  elements.editTimeHint.textContent = "";
  try {
    await saveAttendance(record);
    closeEditTimeModal();
  } catch {
    elements.editTimeHint.textContent = "Failed to save. Please try again.";
  } finally {
    elements.saveEditTimeBtn.disabled = false;
  }
}

// ---- USERS (Super Admin) ----

function renderUserEmployeeOptions() {
  if (!elements.userEmployeeLink) return;
  const sortedEmployees = [...state.employees].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  elements.userEmployeeLink.innerHTML = '<option value="">Select employee...</option>'
    .concat(sortedEmployees.map((e) => `<option value="${escapeHtml(e.uid)}">${escapeHtml(e.name)} (${escapeHtml(e.employeeId || e.uid)})</option>`).join(""));
}

function userRow(user) {
  const employee = user.employeeUid ? state.employees.find((e) => e.uid === user.employeeUid) : null;
  const isSelf = user.id === state.user?.uid;
  return `<tr>
    <td data-label="Name">${escapeHtml(user.name || "-")}</td>
    <td data-label="Email">${escapeHtml(user.email || "-")}</td>
    <td data-label="Role"><span class="pill role-${escapeHtml(user.role)}">${escapeHtml(ROLE_LABELS[user.role] || user.role)}</span></td>
    <td data-label="Linked Employee">${employee ? escapeHtml(employee.name) : "-"}</td>
    <td data-label="Actions">
      ${isSelf ? '<span class="support-note">This is you</span>' : state.role === "hr" && user.role === "super_admin" ? '<span class="support-note">Super Admin</span>' : `<button class="mini-btn" data-revoke-user="${escapeHtml(user.id)}" type="button">Revoke Access</button>`}
    </td>
  </tr>`;
}

function renderUsersTable() {
  if (!elements.usersTableBody) return;
  elements.usersTableBody.innerHTML = state.users.map(userRow).join("") || '<tr><td colspan="5" class="empty-state">No users yet.</td></tr>';
  elements.usersTableBody.querySelectorAll("[data-revoke-user]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.getAttribute("data-revoke-user");
      if (userId && confirm("Revoke this login's access? They will no longer be able to sign in.")) {
        await revokeUserAccess(userId);
      }
    });
  });
}

// ---- DEVICES (Super Admin): approve ESP32 card readers ----
// A reader has no password. It signs in anonymously and registers devices/{uid} as pending; approving
// it writes users/{uid} with role "device" (that doc is what the security rules check). Revoking deletes it.

function formatWhen(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function deviceIsApproved(deviceId) {
  return state.users.some((u) => u.id === deviceId && u.role === "device");
}

function deviceRow(device) {
  const approved = deviceIsApproved(device.id);
  const id = escapeHtml(device.id);
  const actions = approved
    ? `<button class="mini-btn" data-revoke-device="${id}" type="button">Revoke</button>`
    : `<button class="mini-btn" data-approve-device="${id}" type="button">Approve</button>`;
  return `<tr>
    <td data-label="Reader"><strong>${escapeHtml(device.name || "Card reader")}</strong></td>
    <td data-label="Device ID"><code>${escapeHtml(String(device.id).slice(0, 8))}&hellip;</code></td>
    <td data-label="First seen">${escapeHtml(formatWhen(device.requestedAt))}</td>
    <td data-label="Last seen">${escapeHtml(formatWhen(device.lastSeenAt))}</td>
    <td data-label="Status"><span class="pill ${approved ? "done" : "info"}">${approved ? "Approved" : "Pending"}</span></td>
    <td data-label="Actions">${actions} <button class="mini-btn" data-remove-device="${id}" type="button">Remove</button></td>
  </tr>`;
}

function renderDevicesTable() {
  if (!elements.devicesTableBody) return;
  elements.devicesTableBody.innerHTML = state.devices.map(deviceRow).join("")
    || '<tr><td colspan="6" class="empty-state">No card readers yet. Power on a reader flashed with the WiFi firmware and it will appear here as Pending.</td></tr>';
  const wire = (attr, fn) => elements.devicesTableBody.querySelectorAll(`[${attr}]`).forEach((btn) => {
    btn.addEventListener("click", () => fn(btn.getAttribute(attr)));
  });
  wire("data-approve-device", approveDevice);
  wire("data-revoke-device", (id) => { if (confirm("Revoke this reader? It will stop recording attendance until you approve it again.")) revokeDevice(id); });
  wire("data-remove-device", (id) => { if (confirm("Remove this reader from the list? (It will show up as Pending again if it is still switched on.)")) removeDevice(id); });
}

async function approveDevice(deviceId) {
  const device = state.devices.find((d) => d.id === deviceId);
  if (!device || !canManageLogins() || !state.db) return;
  try {
    await state.db.collection("users").doc(deviceId).set({
      email: null,
      name: String(device.name || "Card reader"),
      role: "device",
      employeeUid: null,
      createdAt: new Date().toISOString(),
      createdBy: state.user.email,
    });
  } catch (error) {
    handleFirestoreError(error);
  }
}

async function revokeDevice(deviceId) {
  if (!canManageLogins() || !state.db) return;
  try {
    await state.db.collection("users").doc(deviceId).delete();
  } catch (error) {
    handleFirestoreError(error);
  }
}

async function removeDevice(deviceId) {
  if (!canManageLogins() || !state.db) return;
  try {
    const batch = state.db.batch();
    batch.delete(state.db.collection("users").doc(deviceId));
    batch.delete(state.db.collection("devices").doc(deviceId));
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error);
  }
}

async function createStaffAccount({ email, password, role, name, employeeUid }) {
  if (!window.firebase.apps.some((a) => a.name === "secondary")) {
    window.firebase.initializeApp(appConfig.firebase, "secondary");
  }
  const secondaryApp = window.firebase.app("secondary");
  const secondaryAuth = secondaryApp.auth();
  let cred = null;
  try {
    cred = await secondaryAuth.createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;
    await state.db.collection("users").doc(uid).set({
      email: email.trim().toLowerCase(),
      name: name.trim(),
      role,
      employeeUid: role === "employee" ? employeeUid || null : null,
      createdAt: new Date().toISOString(),
      createdBy: state.user.email,
    });
    await secondaryAuth.signOut();
    return { ok: true };
  } catch (error) {
    // If the sign-in account was created but the database refused the role record, remove that
    // account again - otherwise the email stays "already in use" with no way to retry.
    if (cred?.user) { try { await cred.user.delete(); } catch {} }
    try { await secondaryAuth.signOut(); } catch {}
    const code = error?.code || "";
    let message = error?.message || "Failed to create login.";
    if (code.includes("permission-denied")) message = "You are not allowed to create this kind of login.";
    else if (code.includes("email-already-in-use")) message = "An account with this email already exists.";
    else if (code.includes("weak-password")) message = "Password must be at least 6 characters.";
    else if (code.includes("invalid-email")) message = "Invalid email format.";
    return { ok: false, message };
  }
}

async function revokeUserAccess(userId) {
  try {
    await state.db.collection("users").doc(userId).delete();
  } catch (error) {
    handleFirestoreError(error);
  }
}

async function handleUserSubmit(event) {
  event.preventDefault();
  const name = elements.userName.value.trim();
  const email = elements.userEmail.value.trim();
  const password = elements.userPassword.value;
  const role = state.role === "hr" && elements.userRole.value === "super_admin" ? "employee" : elements.userRole.value; // HR can't make Super Admins
  const employeeUid = elements.userEmployeeLink.value;

  if (!name || !email || !password || !role) {
    elements.userFormHint.textContent = "Please complete all required fields.";
    return;
  }
  if (role === "employee" && !employeeUid) {
    elements.userFormHint.textContent = "Select the employee this login belongs to.";
    return;
  }

  elements.createUserBtn.disabled = true;
  elements.userFormHint.textContent = "Creating login...";
  const result = await createStaffAccount({ email, password, role, name, employeeUid });
  elements.createUserBtn.disabled = false;
  if (result.ok) {
    elements.userForm.reset();
    elements.userRole.dispatchEvent(new Event("change"));
    elements.userFormHint.textContent = "Login created.";
  } else {
    elements.userFormHint.textContent = result.message;
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

  // Cooldown: ignore duplicate scans of the same UID within 30 seconds
  if (uid && source === "serial") {
    const lastScan = scanCooldowns.get(uid);
    if (lastScan && now.getTime() - lastScan < SCAN_COOLDOWN_MS) {
      return;
    }
    scanCooldowns.set(uid, now.getTime());
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
    recordUnknownCard(uid, source);
    state.liveOutput = { status: "error", message: "UNKNOWN CARD", uid, time, source };
    state.scanFeed.unshift({ uid, type: "error", name: "Unknown", message: "UNKNOWN CARD", time, source });
    state.scanFeed = state.scanFeed.slice(0, 8);
    renderAll();
    return;
  }

  // Auto-open this employee's panel so the admin can watch the scan live
  openEmployeeDrawer(employee.uid);

  let daily = await getAttendanceRecord(uid, dateKey);
  if (daily) {
    daily.employeeId = daily.employeeId || employee.employeeId;
    daily.employeeName = daily.employeeName || employee.name;
  }

  // A rejected save (permission denied, offline...) must not look like a successful scan, and must not
  // leave the 90 s serial cooldown blocking the retry.
  const failScan = () => {
    scanCooldowns.delete(uid);
    state.scanFeed.unshift({ uid, type: "error", name: employee.name, message: "Scan was NOT saved", time, source });
    state.scanFeed = state.scanFeed.slice(0, 8);
    renderAll();
  };

  if (!daily) {
    const checkInLocation = await getCurrentLocation();
    daily = { uid, employeeId: employee.employeeId, employeeName: employee.name, dateKey, checkIn: time, checkOut: null, checkInLocation };
    try {
      await saveAttendance(daily);
    } catch {
      failScan(); // saveAttendance already put the reason in the live output
      return;
    }
    state.liveOutput = { status: "success", type: "CHECK_IN", employee: employee.name, employee_id: employee.employeeId, check_in: time, uid, location: checkInLocation };
    state.scanFeed.unshift({ uid, type: "CHECK_IN", name: employee.name, message: `${employee.name} checked in`, time, source });
    state.scanFeed = state.scanFeed.slice(0, 8);
    if (!state.attendance.some((e) => e.uid === uid && e.dateKey === dateKey)) state.attendance.unshift(daily);
    renderAll();
    return;
  }

  if (!daily.checkOut) {
    const checkOutLocation = await getCurrentLocation();
    daily.checkOut = time;
    daily.checkOutLocation = checkOutLocation;
    try {
      await saveAttendance(daily);
    } catch {
      failScan();
      return;
    }
    state.liveOutput = { status: "success", type: "CHECK_OUT", employee: employee.name, employee_id: employee.employeeId, check_in: daily.checkIn, check_out: time, uid, location: checkOutLocation };
    state.scanFeed.unshift({ uid, type: "CHECK_OUT", name: employee.name, message: `${employee.name} checked out`, time, source });
    state.scanFeed = state.scanFeed.slice(0, 8);
    const idx = state.attendance.findIndex((e) => e.uid === uid && e.dateKey === dateKey);
    if (idx >= 0) state.attendance[idx] = daily;
    else state.attendance.unshift(daily);
    renderAll();
    return;
  }

  state.liveOutput = { status: "info", type: "ALREADY_DONE", employee: employee.name, message: "Already checked in and out today", uid, time };
  state.scanFeed.unshift({ uid, type: "done", name: employee.name, message: "Already checked in and out today", time, source });
  state.scanFeed = state.scanFeed.slice(0, 8);
  renderAll();
}

function loadSampleData() {
  if (state.db && state.role !== "super_admin") return;
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
    branch: elements.employeeBranch.value.trim(),
    department: elements.employeeDepartment.value.trim(),
    role: elements.employeeRole.value.trim(),
    phone: elements.employeePhone.value.trim(),
    shiftStart: elements.employeeShiftStart.value,
    shiftEnd: elements.employeeShiftEnd.value,
  };
  if (!validShiftTime(employee.shiftStart) || !validShiftTime(employee.shiftEnd) || employee.shiftStart === employee.shiftEnd) {
    alert("Please enter a valid shift start and end time.");
    return;
  }
  if (!employee.uid || !employee.employeeId || !employee.name || !employee.branch || !employee.department || !employee.role) {
    alert("Please complete all required fields.");
    return;
  }

  // A card can belong to only one employee, and an Employee ID to only one person. Without these
  // checks, saving silently overwrote whoever already had that card / ID.
  if (state.editingEmployeeUid) {
    employee.uid = state.editingEmployeeUid;
  } else {
    const cardOwner = state.employees.find((e) => e.uid === employee.uid);
    if (cardOwner) {
      alert(`Card ${employee.uid} is already assigned to ${cardOwner.name} (${cardOwner.employeeId}). Use a different card, or edit that employee.`);
      return;
    }
    // A reused card may still carry history from an employee HR deleted. Don't hand it to the new person.
    const leftovers = orphanCountFor(employee.uid);
    if (leftovers) {
      if (state.role !== "super_admin") {
        alert(`Card ${employee.uid} still has ${leftovers} old record(s) from a deleted employee. Ask a Super Admin to assign this card (they can clear the old records), or use another card.`);
        return;
      }
      if (!confirm(`Card ${employee.uid} still has ${leftovers} old record(s) from a deleted employee. Delete them so ${employee.name} starts clean?`)) return;
      await clearOrphanHistory(employee.uid);
    }
  }
  const idOwner = state.employees.find((e) => e.uid !== employee.uid && String(e.employeeId || "").toLowerCase() === employee.employeeId.toLowerCase());
  if (idOwner) {
    alert(`Employee ID ${employee.employeeId} is already used by ${idOwner.name}.`);
    return;
  }

  await saveEmployee(employee);
  const assignedCard = state.unknownCards.some((c) => c.uid === employee.uid);
  clearEmployeeForm();
  if (assignedCard) {
    await dismissUnknownCard(employee.uid);
    state.liveOutput = { status: "success", message: `Card ${employee.uid} assigned to ${employee.name}` };
    location.hash = "#dashboard";
  }
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
  }
}

// ---- WIRING ----

function openSidebar() {
  elements.sidebar.classList.add("is-open");
  elements.sidebarBackdrop.classList.remove("hidden");
}

function closeSidebar() {
  elements.sidebar.classList.remove("is-open");
  elements.sidebarBackdrop.classList.add("hidden");
}

function bindNavButtons() {
  document.querySelectorAll("[data-route]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeSidebar();
      // Clicking "Add Employee" in the menu means a NEW employee: drop any half-finished edit (and its locked UID).
      if (btn.dataset.route === "employees/add" && state.editingEmployeeUid) clearEmployeeForm();
      const target = `#${btn.dataset.route}`;
      if (location.hash === target) {
        router();
      } else {
        location.hash = target;
      }
    });
  });
  window.addEventListener("hashchange", router);
}

function wireEvents() {
  elements.openSidebarBtn.addEventListener("click", openSidebar);
  elements.dockMoreBtn.addEventListener("click", openSidebar);
  elements.closeDeleteEmpBtn.addEventListener("click", closeDeleteEmployeeModal);
  elements.deleteEmpBackdrop.addEventListener("click", closeDeleteEmployeeModal);
  elements.removeCardOnlyBtn.addEventListener("click", () => runDeleteAction("card"));
  elements.deleteEverythingBtn.addEventListener("click", () => runDeleteAction("all"));
  elements.closeAssignCardBtn.addEventListener("click", closeAssignCardModal);
  elements.assignCardBackdrop.addEventListener("click", closeAssignCardModal);
  elements.saveAssignCardBtn.addEventListener("click", saveAssignCard);
  elements.assignCardInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveAssignCard(); });
  elements.closeSidebarBtn.addEventListener("click", closeSidebar);
  elements.sidebarBackdrop.addEventListener("click", closeSidebar);
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.signOutBtn.addEventListener("click", () => { closeSidebar(); state.auth?.signOut(); });
  elements.signOutBtnSecondary.addEventListener("click", () => state.auth?.signOut());
  elements.employeeForm.addEventListener("submit", handleEmployeeSubmit);
  elements.clearEmployeeFormBtn.addEventListener("click", clearEmployeeForm);

  elements.employeeSearchInput.addEventListener("input", () => {
    state.employeeSearch = elements.employeeSearchInput.value;
    renderEmployeeTable();
  });

  elements.attendanceEmployeeFilter.addEventListener("change", () => { state.attendanceEmployeeUid = elements.attendanceEmployeeFilter.value; renderAttendanceTable(); });
  elements.attendanceFromInput.addEventListener("change", () => { state.attendanceFrom = elements.attendanceFromInput.value; renderAttendanceTable(); });
  elements.attendanceToInput.addEventListener("change", () => { state.attendanceTo = elements.attendanceToInput.value; renderAttendanceTable(); });
  elements.attendanceSearchInput.addEventListener("input", () => { state.attendanceSearch = elements.attendanceSearchInput.value; renderAttendanceTable(); });
  elements.clearAttendanceFiltersBtn.addEventListener("click", () => {
    elements.attendanceEmployeeFilter.value = "";
    elements.attendanceFromInput.value = "";
    elements.attendanceToInput.value = "";
    elements.attendanceSearchInput.value = "";
    state.attendanceEmployeeUid = "";
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

  elements.demoScanBtn.addEventListener("click", async () => {
    if (!state.employees.length) loadSampleData();
    await processScan(state.employees[0]?.uid || sampleEmployees[0].uid, "demo");
  });
  elements.scanFromInputBtn.addEventListener("click", async () => { await processScan(elements.manualUidInput.value, "manual"); });
  elements.manualUidInput.addEventListener("keydown", async (e) => { if (e.key === "Enter") { e.preventDefault(); await processScan(elements.manualUidInput.value, "manual"); } });

  // Shift presets fill the time inputs; editing a time switches the preset to "Custom".
  const wirePreset = (selectEl, startEl, endEl) => {
    selectEl.addEventListener("change", () => {
      if (selectEl.value === "custom") return;
      const [start, end] = selectEl.value.split("-");
      startEl.value = start;
      endEl.value = end;
    });
    [startEl, endEl].forEach((el) => el.addEventListener("change", () => setPresetFromTimes(selectEl, startEl.value, endEl.value)));
  };
  wirePreset(elements.employeeShiftPreset, elements.employeeShiftStart, elements.employeeShiftEnd);
  wirePreset(elements.shiftPresetSelect, elements.shiftStartInput, elements.shiftEndInput);

  // Shift editor (calendar side panel)
  elements.shiftEmployeeSelect.addEventListener("change", syncShiftEditorTimes);
  elements.shiftFromDate.addEventListener("change", () => {
    if (!elements.shiftToDate.value || elements.shiftToDate.value < elements.shiftFromDate.value) {
      elements.shiftToDate.value = elements.shiftFromDate.value;
    }
    syncShiftEditorTimes();
  });
  elements.saveShiftBtn.addEventListener("click", () => saveShiftOverride(false));
  elements.resetShiftBtn.addEventListener("click", () => saveShiftOverride(true));

  // Sheet downloads: the Attendance page uses its employee + date filters; the drawer is one employee.
  elements.downloadSheetBtn.addEventListener("click", () => {
    const uid = state.attendanceEmployeeUid;
    const uids = uid ? [uid] : state.employees.map((e) => e.uid);
    downloadSheet(uids, state.attendanceFrom, state.attendanceTo, uid ? getEmployeeName(uid) : "all-employees");
  });
  elements.drawerDownloadBtn.addEventListener("click", () => {
    const uid = state.selectedEmployeeUid;
    if (!uid) return;
    let from = state.drawerFrom;
    let to = state.drawerTo;
    if (!from && !to && state.drawerMonth) {
      from = `${state.drawerMonth}-01`;
      to = `${state.drawerMonth}-${String(daysInMonth(state.drawerMonth)).padStart(2, "0")}`;
    }
    downloadSheet([uid], from, to, getEmployeeName(uid));
  });

  // Live card toast
  elements.cardToastAssignBtn.addEventListener("click", () => { if (cardToastUid) startAssignCard(cardToastUid); });
  elements.cardToastCloseBtn.addEventListener("click", hideCardToast);

  // Company calendar
  elements.calPrevBtn.addEventListener("click", () => {
    state.calendarPageMonth = shiftMonth(state.calendarPageMonth || todayKey().slice(0, 7), -1);
    renderCompanyCalendar();
  });
  elements.calNextBtn.addEventListener("click", () => {
    state.calendarPageMonth = shiftMonth(state.calendarPageMonth || todayKey().slice(0, 7), 1);
    renderCompanyCalendar();
  });

  // Drawer events
  elements.drawerBackdrop.addEventListener("click", closeEmployeeDrawer);
  elements.closeDrawerBtn.addEventListener("click", closeEmployeeDrawer);
  // Month and date range are alternatives: using one resets the other, so the box always shows what is filtered.
  const onDrawerDates = () => {
    state.drawerFrom = elements.drawerFromInput.value;
    state.drawerTo = elements.drawerToInput.value;
    state.drawerMonth = "";
    renderDrawer();
  };
  elements.drawerFromInput.addEventListener("change", onDrawerDates);
  elements.drawerToInput.addEventListener("change", onDrawerDates);
  elements.drawerMonthSelect.addEventListener("change", () => {
    state.drawerMonth = elements.drawerMonthSelect.value;
    state.drawerFrom = "";
    state.drawerTo = "";
    elements.drawerFromInput.value = "";
    elements.drawerToInput.value = "";
    renderDrawer();
  });
  elements.drawerCalPrevBtn.addEventListener("click", () => {
    const employee = state.employees.find((e) => e.uid === state.selectedEmployeeUid);
    if (!employee) return;
    state.calendarMonth = shiftMonth(state.calendarMonth || todayKey().slice(0, 7), -1);
    renderDrawerCalendar(employee);
  });
  elements.drawerCalNextBtn.addEventListener("click", () => {
    const employee = state.employees.find((e) => e.uid === state.selectedEmployeeUid);
    if (!employee) return;
    state.calendarMonth = shiftMonth(state.calendarMonth || todayKey().slice(0, 7), 1);
    renderDrawerCalendar(employee);
  });
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

  // Users (Super Admin)
  elements.userForm.addEventListener("submit", handleUserSubmit);
  elements.userRole.addEventListener("change", () => {
    elements.userEmployeeLinkWrap.classList.toggle("hidden", elements.userRole.value !== "employee");
  });
  elements.userRole.dispatchEvent(new Event("change"));

  // Edit Time modal (Super Admin)
  elements.closeEditTimeBtn.addEventListener("click", closeEditTimeModal);
  elements.editTimeBackdrop.addEventListener("click", closeEditTimeModal);
  elements.saveEditTimeBtn.addEventListener("click", saveEditTime);
  elements.clearEditTimeBtn.addEventListener("click", () => {
    elements.editTimeCheckIn.value = "";
    elements.editTimeCheckOut.value = "";
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
  router();
}

document.addEventListener("DOMContentLoaded", initialize);
