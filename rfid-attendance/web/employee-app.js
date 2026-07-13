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
  employees: [],
  attendance: [],
  filterMonth: "",
  filterFrom: "",
  filterTo: "",
};

let attendanceUnsub = null;

const el = {};

function hasFirebaseConfig() {
  const c = appConfig.firebase || {};
  return Boolean(c.apiKey && c.projectId && c.appId);
}

async function initFirebase() {
  if (!window.firebase || !hasFirebaseConfig()) return;
  if (!window.firebase.apps.length) {
    window.firebase.initializeApp(appConfig.firebase);
  }
  state.db = window.firebase.firestore();
  state.auth = window.firebase.auth();

  // Sign in anonymously so Firestore reads are allowed
  try {
    await state.auth.signInAnonymously();
  } catch {
    // If anonymous auth is not enabled, try reading without auth
  }
  state.authReady = true;

  // Preload all employees for lookup
  try {
    const snap = await state.db.collection("employees").get();
    state.employees = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  } catch {
    state.employees = [];
  }
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
    "empLoginView", "empLoginForm", "empLoginId", "empLoginHint",
    "empDashboard", "empWelcome", "empInfoPill", "empLogoutBtn",
    "empProfileName", "empProfileGrid",
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

function findEmployee(query) {
  const q = query.trim().toUpperCase();
  if (!q) return null;

  const list = state.db ? state.employees : sampleEmployees;

  // Match by employeeId (exact, case-insensitive)
  let found = list.find((e) => (e.employeeId || "").toUpperCase() === q);
  if (found) return found;

  // Match by UID (exact, case-insensitive)
  found = list.find((e) => (e.uid || "").toUpperCase() === q);
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
    <div class="setting-card"><span>Department</span><strong>${emp.department}</strong></div>
    <div class="setting-card"><span>Role</span><strong>${emp.role}</strong></div>
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

async function clearCheckout(dateKey, uid) {
  if (!state.db) return;
  if (!confirm("Clear checkout time? You will need to scan your card again to check out.")) return;
  try {
    await state.db.collection("attendance").doc(`${dateKey}_${uid}`).update({
      checkOut: window.firebase.firestore.FieldValue.delete(),
    });
  } catch (err) {
    console.error("Failed to clear checkout:", err);
    alert("Failed to clear checkout. Please try again.");
  }
}

function renderAttendance() {
  const months = getMonthOptions(state.attendance);
  const currentMonth = state.filterMonth || "";
  const today = todayKey();

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
    const canClear = record.dateKey === today && record.checkOut && state.db;
    const actionHtml = canClear
      ? `<button class="mini-btn clear-checkout-btn" data-datekey="${record.dateKey}" data-uid="${record.uid}" type="button">Clear Checkout</button>`
      : "-";
    return `<tr>
      <td>${record.dateKey || "-"}</td>
      <td>${record.checkIn || "-"}</td>
      <td>${record.checkOut || "-"}</td>
      <td>${hours}</td>
      <td><span class="pill ${pillClass}">${status}</span></td>
      <td>${actionHtml}</td>
    </tr>`;
  }).join("");

  el.empAttendanceBody.innerHTML = rows || '<tr><td colspan="6" class="empty-state">No attendance records found.</td></tr>';

  // Wire clear checkout buttons
  el.empAttendanceBody.querySelectorAll(".clear-checkout-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      clearCheckout(btn.getAttribute("data-datekey"), btn.getAttribute("data-uid"));
    });
  });
}

async function handleEmpLogin(event) {
  event.preventDefault();
  const query = el.empLoginId.value.trim();
  if (!query) {
    el.empLoginHint.textContent = "Please enter your Employee ID or UID.";
    return;
  }

  el.empLoginHint.textContent = "Searching...";

  try {
    // If firebase employees haven't loaded yet, try loading now
    if (state.db && state.employees.length === 0) {
      try {
        const snap = await state.db.collection("employees").get();
        state.employees = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
      } catch (err) {
        el.empLoginHint.textContent = "Unable to connect to database. Please try again.";
        console.error("Firestore read error:", err);
        return;
      }
    }

    const employee = findEmployee(query);
    if (!employee) {
      el.empLoginHint.textContent = "Employee not found. Please check your ID or UID.";
      return;
    }

    state.employee = employee;
    listenAttendance(employee.uid);

    sessionStorage.setItem("empLoggedIn", JSON.stringify({ uid: employee.uid, employeeId: employee.employeeId }));

    showDashboard();
    renderProfile();
    renderAttendance();
  } catch (error) {
    console.error("Login error:", error);
    el.empLoginHint.textContent = "Something went wrong: " + (error.message || "Please try again.");
  }
}

function handleLogout() {
  stopAttendanceListener();
  state.employee = null;
  state.attendance = [];
  state.filterMonth = "";
  state.filterFrom = "";
  state.filterTo = "";
  sessionStorage.removeItem("empLoggedIn");
  el.empLoginId.value = "";
  el.empLoginHint.textContent = "";
  showLogin();
}

function wireEvents() {
  el.empLoginForm.addEventListener("submit", handleEmpLogin);
  el.empLogoutBtn.addEventListener("click", handleLogout);

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

async function tryRestoreSession() {
  const saved = sessionStorage.getItem("empLoggedIn");
  if (!saved) return false;

  try {
    const { uid, employeeId } = JSON.parse(saved);
    const employee = findEmployee(employeeId || uid);
    if (!employee) {
      sessionStorage.removeItem("empLoggedIn");
      return false;
    }

    state.employee = employee;
    listenAttendance(employee.uid);
    showDashboard();
    renderProfile();
    renderAttendance();
    return true;
  } catch {
    sessionStorage.removeItem("empLoggedIn");
    return false;
  }
}

async function initialize() {
  cacheElements();
  wireEvents();

  // Init firebase and wait for auth + employee data to load
  await initFirebase();

  const restored = await tryRestoreSession();
  if (!restored) {
    showLogin();
    if (!hasFirebaseConfig()) {
      el.empLoginHint.textContent = "System is in local demo mode. Try EMP001, EMP002, or EMP003.";
    }
  }
}

document.addEventListener("DOMContentLoaded", initialize);
