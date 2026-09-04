const appConfig = window.__APP_CONFIG__ || { appName: "TechCADD Attendance", firebase: {} };

const sampleEmployees = [
  { uid: "A1B2C3D4", employeeId: "EMP001", name: "John Smith", department: "Engineering", role: "Engineer", phone: "+91 9000000001" },
  { uid: "E5F6G7H8", employeeId: "EMP002", name: "Sarah Johnson", department: "Marketing", role: "Lead", phone: "+91 9000000002" },
  { uid: "I9J0K1L2", employeeId: "EMP003", name: "Mike Wilson", department: "HR", role: "Coordinator", phone: "+91 9000000003" },
];

const state = {
  db: null,
  auth: null,
  authReady: false,
  employee: null,
  attendance: [],
  filterMonth: "",
  filterFrom: "",
  filterTo: "",
  actionPending: false,
};

let attendanceUnsub = null;
let todayTickHandle = null;

const DELETE_WINDOW_MS = 5 * 60 * 1000;

const el = {};

function hasFirebaseConfig() {
  const c = appConfig.firebase || {};
  return Boolean(c.apiKey && c.projectId && c.appId);
}

function initFirebase() {
  if (!window.firebase || !hasFirebaseConfig()) return;
  if (!window.firebase.apps.length) {
    window.firebase.initializeApp(appConfig.firebase);
  }
  state.db = window.firebase.firestore();
  state.auth = window.firebase.auth();
  state.authReady = true;
  state.auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL).catch(() => null);
}

async function loadMyEmployee(user) {
  const snap = await state.db.collection("users").doc(user.uid).get();
  if (!snap.exists || snap.data().role !== "employee" || !snap.data().employeeUid) {
    return { ok: false, message: "This login is not set up as an employee account. Use the Admin Login if you are staff." };
  }
  const employeeUid = snap.data().employeeUid;
  const empSnap = await state.db.collection("employees").doc(employeeUid).get();
  if (!empSnap.exists) {
    return { ok: false, message: "Your employee profile was not found. Contact your administrator." };
  }
  return { ok: true, employee: { uid: empSnap.id, ...empSnap.data() } };
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
    "empLoginView", "empLoginForm", "empLoginEmail", "empLoginPassword", "empLoginHint",
    "empDashboard", "empWelcome", "empInfoPill", "empLogoutBtn",
    "empProfileName", "empProfileGrid",
    "empTodayPill", "empTodayStatus", "empScanWrap", "empScanBtn", "empDeleteWrap", "empDeleteBtn",
    "empScanHint",
    "empMetricTotal", "empMetricPresent", "empMetricCompleted", "empMetricHours",
    "empMonthSelect", "empFromDate", "empToDate", "empClearFilters",
    "empMonthSummary", "empAttendanceBody",
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
}

function showLogin() {
  el.empLoginView.classList.remove("hidden");
  el.empDashboard.classList.add("hidden");
}

function showDashboard() {
  el.empLoginView.classList.add("hidden");
  el.empDashboard.classList.remove("hidden");
}

function findDemoEmployee(query) {
  const q = query.trim().toUpperCase();
  if (!q) return null;

  let found = sampleEmployees.find((e) => (e.employeeId || "").toUpperCase() === q);
  if (found) return found;

  found = sampleEmployees.find((e) => (e.uid || "").toUpperCase() === q);
  if (found) return found;

  return null;
}

function stopAttendanceListener() {
  if (attendanceUnsub) {
    attendanceUnsub();
    attendanceUnsub = null;
  }
}

function listenAttendance(uid) {
  stopAttendanceListener();

  if (!state.db) {
    state.attendance = [];
    return;
  }

  attendanceUnsub = state.db.collection("attendance")
    .where("uid", "==", uid)
    .onSnapshot((snap) => {
      state.attendance = snap.docs
        .map((d) => d.data())
        .filter(Boolean)
        .sort((a, b) => `${b.dateKey}${b.checkIn || ""}`.localeCompare(`${a.dateKey}${a.checkIn || ""}`));
      renderAttendance();
    }, () => {
      state.attendance = [];
      renderAttendance();
    });
}

function renderProfile() {
  const emp = state.employee;
  if (!emp) return;

  el.empWelcome.textContent = `Welcome, ${emp.name}`;
  el.empProfileName.textContent = emp.name;
  el.empInfoPill.textContent = `${emp.employeeId} | ${emp.department}`;

  el.empProfileGrid.innerHTML = `
    <div class="setting-card"><span>UID</span><strong>${emp.uid}</strong></div>
    <div class="setting-card"><span>Employee ID</span><strong>${emp.employeeId}</strong></div>
    <div class="setting-card"><span>Branch</span><strong>${emp.branch || "-"}</strong></div>
    <div class="setting-card"><span>Department</span><strong>${emp.department}</strong></div>
    <div class="setting-card"><span>Job Title</span><strong>${emp.role}</strong></div>
    <div class="setting-card"><span>Phone</span><strong>${emp.phone || "-"}</strong></div>
  `;
}

function renderMetrics(records) {
  const totalDays = records.length;
  const presentDays = records.filter((r) => r.checkIn).length;
  const completedDays = records.filter((r) => r.checkIn && r.checkOut).length;
  let totalMins = 0;
  records.forEach((r) => {
    if (r.checkIn && r.checkOut) totalMins += calcMinutes(r.checkIn, r.checkOut);
  });

  el.empMetricTotal.textContent = totalDays;
  el.empMetricPresent.textContent = presentDays;
  el.empMetricCompleted.textContent = completedDays;
  el.empMetricHours.textContent = `${Math.floor(totalMins / 60)}h ${totalMins % 60}m`;
}

function renderMonthSummary(records) {
  const completedDays = records.filter((r) => r.checkIn && r.checkOut).length;
  const presentDays = records.filter((r) => r.checkIn).length;
  let totalMins = 0;
  records.forEach((r) => {
    if (r.checkIn && r.checkOut) totalMins += calcMinutes(r.checkIn, r.checkOut);
  });
  const avgMins = completedDays > 0 ? Math.round(totalMins / completedDays) : 0;

  el.empMonthSummary.innerHTML = `
    <div class="month-stat"><span>Total Days</span><strong>${records.length}</strong></div>
    <div class="month-stat"><span>Present</span><strong>${presentDays}</strong></div>
    <div class="month-stat"><span>Completed</span><strong>${completedDays}</strong></div>
    <div class="month-stat"><span>Total Hours</span><strong>${Math.floor(totalMins / 60)}h ${totalMins % 60}m</strong></div>
    <div class="month-stat"><span>Avg / Day</span><strong>${Math.floor(avgMins / 60)}h ${avgMins % 60}m</strong></div>
  `;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function locationMapsUrl(location) {
  if (!location) return "";
  return `https://www.google.com/maps?q=${location.lat},${location.lng}`;
}

function locationRow(label, location) {
  const coords = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
  return `<div class="location-row">
    <span class="location-label">${label}</span>
    <span class="location-coords">${coords}</span>
    <a href="${locationMapsUrl(location)}" target="_blank" rel="noopener noreferrer" class="mini-btn" title="${label} location">View</a>
  </div>`;
}

function locationCell(record) {
  const rows = [];
  if (record.checkInLocation) rows.push(locationRow("In", record.checkInLocation));
  if (record.checkOutLocation) rows.push(locationRow("Out", record.checkOutLocation));
  return rows.length ? rows.join("") : "-";
}

function getCurrentLocation(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation is not supported by this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      }),
      (err) => reject(new Error(err && err.code === 1
        ? "Location access denied. Please enable location permission and try again."
        : "Unable to get your live location. Please try again.")),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

function formatTimeNow(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

function todayRecordForEmployee() {
  const uid = state.employee?.uid;
  if (!uid) return null;
  const today = todayKey();
  return state.attendance.find((r) => r.uid === uid && r.dateKey === today) || null;
}

function deleteMsLeft(dateKey, timeStr) {
  if (!dateKey || !timeStr) return 0;
  const scannedAt = new Date(`${dateKey}T${timeStr}`).getTime();
  if (Number.isNaN(scannedAt)) return 0;
  return DELETE_WINDOW_MS - (Date.now() - scannedAt);
}

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function startTodayTicker() {
  stopTodayTicker();
  todayTickHandle = setInterval(renderTodayAction, 1000);
}

function stopTodayTicker() {
  if (todayTickHandle) {
    clearInterval(todayTickHandle);
    todayTickHandle = null;
  }
}

function showDeleteButton(action, label, remaining) {
  el.empDeleteWrap.classList.remove("hidden");
  el.empDeleteBtn.disabled = state.actionPending;
  el.empDeleteBtn.textContent = state.actionPending ? "Deleting..." : `${label} (${formatCountdown(remaining)} left)`;
  el.empDeleteBtn.dataset.action = action;
}

function renderTodayAction() {
  if (!el.empScanBtn) return;
  const record = todayRecordForEmployee();
  el.empScanWrap.classList.add("hidden");
  el.empDeleteWrap.classList.add("hidden");

  if (!state.db) {
    el.empTodayPill.textContent = "Demo Mode";
    el.empTodayPill.className = "status-pill";
    el.empTodayStatus.textContent = "Location capture needs a live database connection.";
    return;
  }

  if (!record || !record.checkIn) {
    el.empTodayPill.textContent = "Waiting for Card Scan";
    el.empTodayPill.className = "status-pill";
    el.empTodayStatus.textContent = "You haven't tapped your card today. Tap your RFID card at the reader to check in.";
    return;
  }

  if (!record.checkOut) {
    if (!record.checkInLocation) {
      el.empTodayPill.textContent = "Location Needed";
      el.empTodayPill.className = "status-pill accent";
      el.empTodayStatus.textContent = `Checked in via card at ${record.checkIn}. Verify your location to confirm.`;
      el.empScanWrap.classList.remove("hidden");
      el.empScanBtn.disabled = state.actionPending;
      el.empScanBtn.textContent = state.actionPending ? "Getting your location..." : "Verify My Location";
      el.empScanBtn.dataset.action = "checkin-location";
    } else {
      el.empTodayPill.textContent = "Checked In";
      el.empTodayPill.className = "status-pill accent";
      el.empTodayStatus.textContent = `Checked in at ${record.checkIn} (location confirmed). Tap your card again when you leave.`;
    }

    const remaining = deleteMsLeft(record.dateKey, record.checkIn);
    if (remaining > 0) showDeleteButton("checkin", "Delete Check-In", remaining);
    return;
  }

  if (!record.checkOutLocation) {
    el.empTodayPill.textContent = "Location Needed";
    el.empTodayPill.className = "status-pill accent";
    el.empTodayStatus.textContent = `Checked out via card at ${record.checkOut}. Verify your location to confirm.`;
    el.empScanWrap.classList.remove("hidden");
    el.empScanBtn.disabled = state.actionPending;
    el.empScanBtn.textContent = state.actionPending ? "Getting your location..." : "Verify My Location";
    el.empScanBtn.dataset.action = "checkout-location";
  } else {
    el.empTodayPill.textContent = "Complete";
    el.empTodayPill.className = "status-pill";
    el.empTodayStatus.textContent = `Checked in ${record.checkIn} · Checked out ${record.checkOut}. Today is complete.`;
  }

  const remaining = deleteMsLeft(record.dateKey, record.checkOut);
  if (remaining > 0) showDeleteButton("checkout", "Delete Check-Out", remaining);
}

async function captureLocation(action) {
  if (!state.db || !state.employee || state.actionPending || !action) return;

  state.actionPending = true;
  el.empScanHint.textContent = "";
  renderTodayAction();

  try {
    const location = await getCurrentLocation();
    const uid = state.employee.uid;
    const dateKey = todayKey();
    const capturedAt = new Date().toISOString();
    const docRef = state.db.collection("attendance").doc(`${dateKey}_${uid}`);

    if (action === "checkin-location") {
      await docRef.set({ checkInLocation: location, checkInLocationAt: capturedAt }, { merge: true });
    } else {
      await docRef.set({ checkOutLocation: location, checkOutLocationAt: capturedAt }, { merge: true });
    }
  } catch (err) {
    console.error("Location capture failed:", err);
    el.empScanHint.textContent = err.message || "Something went wrong. Please try again.";
  } finally {
    state.actionPending = false;
    renderTodayAction();
  }
}

async function deleteScan(action) {
  if (!state.db || !state.employee || state.actionPending || !action) return;

  state.actionPending = true;
  el.empScanHint.textContent = "";
  renderTodayAction();

  try {
    const uid = state.employee.uid;
    const dateKey = todayKey();
    const docRef = state.db.collection("attendance").doc(`${dateKey}_${uid}`);

    if (action === "checkin") {
      // Delete the whole document, not just fields: the hardware and admin scan
      // logic both treat "document exists" as proof of an existing check-in, so a
      // leftover empty doc would make the next card tap register as a check-out.
      await docRef.delete();
      el.empScanHint.textContent = "Check-in deleted. Tap your card again to check in.";
    } else {
      const del = window.firebase.firestore.FieldValue.delete();
      await docRef.update({ checkOut: del, checkOutLocation: del, checkOutLocationAt: del });
      el.empScanHint.textContent = "Check-out deleted. Tap your card again to check out.";
    }
  } catch (err) {
    console.error("Delete failed:", err);
    el.empScanHint.textContent = err.message || "Something went wrong. Please try again.";
  } finally {
    state.actionPending = false;
    renderTodayAction();
  }
}

function handleScanBtnClick() {
  captureLocation(el.empScanBtn.dataset.action);
}

function handleDeleteBtnClick() {
  deleteScan(el.empDeleteBtn.dataset.action);
}

function renderAttendance() {
  const months = getMonthOptions(state.attendance);
  const currentMonth = state.filterMonth || "";

  el.empMonthSelect.innerHTML = '<option value="">All Months</option>' +
    months.map((m) => `<option value="${m}" ${m === currentMonth ? "selected" : ""}>${getMonthLabel(m)}</option>`).join("");

  let filtered = state.attendance;
  if (state.filterMonth) {
    filtered = filtered.filter((r) => r.dateKey && r.dateKey.startsWith(state.filterMonth));
  }
  if (state.filterFrom) {
    filtered = filtered.filter((r) => r.dateKey >= state.filterFrom);
  }
  if (state.filterTo) {
    filtered = filtered.filter((r) => r.dateKey <= state.filterTo);
  }

  renderMetrics(state.attendance);
  renderMonthSummary(filtered);

  const rows = filtered.map((record) => {
    const hours = record.checkIn && record.checkOut ? calcHours(record.checkIn, record.checkOut) : "-";
    const status = calcStatus(record);
    const pillClass = statusPillClass(status);
    const lockHtml = !record.checkIn || !record.checkOut
      ? "-"
      : deleteMsLeft(record.dateKey, record.checkOut) > 0
        ? '<span class="pill info">Editable</span>'
        : '<span class="pill done">Locked</span>';
    return `<tr>
      <td data-label="Date">${record.dateKey || "-"}</td>
      <td data-label="Check In">${record.checkIn || "-"}</td>
      <td data-label="Check Out">${record.checkOut || "-"}</td>
      <td data-label="Hours">${hours}</td>
      <td data-label="Status"><span class="pill ${pillClass}">${status}</span></td>
      <td data-label="Location">${locationCell(record)}</td>
      <td data-label="Lock">${lockHtml}</td>
    </tr>`;
  }).join("");

  el.empAttendanceBody.innerHTML = rows || '<tr><td colspan="7" class="empty-state">No attendance records found.</td></tr>';

  renderTodayAction();
}

async function handleEmpLogin(event) {
  event.preventDefault();
  const email = el.empLoginEmail.value.trim();
  const password = el.empLoginPassword.value;

  if (!state.db) {
    // Local demo mode: no live Firebase configured, match against sample employees by ID.
    const employee = findDemoEmployee(email);
    if (!employee) {
      el.empLoginHint.textContent = "Employee not found. Demo mode: type EMP001, EMP002 or EMP003 in the Email field.";
      return;
    }
    state.employee = employee;
    listenAttendance(employee.uid);
    showDashboard();
    renderProfile();
    renderAttendance();
    startTodayTicker();
    return;
  }

  if (!email || !password) {
    el.empLoginHint.textContent = "Please enter your email and password.";
    return;
  }

  el.empLoginHint.textContent = "Signing in...";
  try {
    await state.auth.signInWithEmailAndPassword(email, password);
    // onAuthStateChanged takes over from here.
  } catch (error) {
    const code = error?.code || "";
    if (code.includes("user-not-found") || code.includes("invalid-credential") || code.includes("wrong-password")) {
      el.empLoginHint.textContent = "Incorrect email or password.";
    } else if (code.includes("too-many-requests")) {
      el.empLoginHint.textContent = "Too many attempts. Please try again later.";
    } else if (code.includes("invalid-email")) {
      el.empLoginHint.textContent = "Invalid email format.";
    } else {
      el.empLoginHint.textContent = "Unable to sign in. Please try again.";
    }
  }
}

async function handleLogout() {
  stopAttendanceListener();
  stopTodayTicker();
  state.employee = null;
  state.attendance = [];
  state.filterMonth = "";
  state.filterFrom = "";
  state.filterTo = "";
  state.actionPending = false;
  el.empLoginEmail.value = "";
  el.empLoginPassword.value = "";
  el.empLoginHint.textContent = "";
  el.empScanHint.textContent = "";
  if (state.auth) {
    await state.auth.signOut();
  } else {
    showLogin();
  }
}

function wireEvents() {
  el.empLoginForm.addEventListener("submit", handleEmpLogin);
  el.empLogoutBtn.addEventListener("click", handleLogout);
  el.empScanBtn.addEventListener("click", handleScanBtnClick);
  el.empDeleteBtn.addEventListener("click", handleDeleteBtnClick);

  el.empMonthSelect.addEventListener("change", () => {
    state.filterMonth = el.empMonthSelect.value;
    renderAttendance();
  });

  el.empFromDate.addEventListener("change", () => {
    state.filterFrom = el.empFromDate.value;
    renderAttendance();
  });

  el.empToDate.addEventListener("change", () => {
    state.filterTo = el.empToDate.value;
    renderAttendance();
  });

  el.empClearFilters.addEventListener("click", () => {
    el.empFromDate.value = "";
    el.empToDate.value = "";
    el.empMonthSelect.value = "";
    state.filterMonth = "";
    state.filterFrom = "";
    state.filterTo = "";
    renderAttendance();
  });
}

function wireAuthState() {
  state.auth.onAuthStateChanged(async (user) => {
    if (!user) {
      stopAttendanceListener();
      stopTodayTicker();
      state.employee = null;
      showLogin();
      return;
    }

    el.empLoginHint.textContent = "Loading your profile...";
    const result = await loadMyEmployee(user);
    if (!result.ok) {
      el.empLoginHint.textContent = result.message;
      await state.auth.signOut();
      return;
    }

    state.employee = result.employee;
    listenAttendance(state.employee.uid);
    showDashboard();
    renderProfile();
    renderAttendance();
    startTodayTicker();
  });
}

function initialize() {
  cacheElements();
  wireEvents();
  initFirebase();

  if (state.auth) {
    wireAuthState();
  } else {
    showLogin();
    el.empLoginHint.textContent = "System is in local demo mode. Type EMP001, EMP002 or EMP003 in the Email field.";
  }
}

document.addEventListener("DOMContentLoaded", initialize);
