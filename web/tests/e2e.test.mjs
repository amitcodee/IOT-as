// End-to-end: the REAL server.mjs serves the REAL pages; Chrome (via playwright-core) logs in as each
// role. Firebase traffic is redirected to the local emulators by (1) intercepting /config.js and
// (2) patching firebase.initializeApp() to call useEmulator() — the app's own code is untouched.
import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  getEnv, closeEnv, resetAndSeed, reseedFirestore, ACCOUNTS, EMPLOYEES, PROJECT, todayLocalKey, anonymousSignUp, fsFetch,
} from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3111;
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const TEST_CONFIG = `window.__APP_CONFIG__ = ${JSON.stringify({
  appName: "RFID Attendance",
  firebase: { apiKey: "fake-key", authDomain: "localhost", projectId: PROJECT, appId: "1:1:web:test" },
})};`;

// Runs before any page script: when firebase-app-compat assigns window.firebase, wrap initializeApp.
const EMULATOR_PATCH = () => {
  let fb;
  Object.defineProperty(window, "firebase", {
    configurable: true,
    get: () => fb,
    set(v) {
      fb = v;
      const orig = v.initializeApp.bind(v);
      v.initializeApp = (cfg, name) => {
        const app = orig(cfg, name);
        app.auth().useEmulator("http://127.0.0.1:9099", { disableWarnings: true });
        app.firestore().useEmulator("127.0.0.1", 8080);
        return app;
      };
    },
  });
};

let server;
let browser;
let uids;
const pageErrors = [];

before(async () => {
  await getEnv();
  ({ uids } = await resetAndSeed());
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: path.join(here, ".."),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 10000);
    server.stdout.on("data", (d) => { if (String(d).includes("running at")) { clearTimeout(t); resolve(); } });
    server.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});
beforeEach(() => reseedFirestore(uids));
after(async () => {
  await browser?.close();
  server?.kill();
  await closeEnv();
});

async function newPage({ geolocation = { latitude: 12.9716, longitude: 77.5946 }, timezoneId } = {}) {
  const ctx = await browser.newContext({
    permissions: geolocation ? ["geolocation"] : [],
    geolocation: geolocation || undefined,
    timezoneId,
    viewport: { width: 1400, height: 900 },
  });
  await ctx.addInitScript(EMULATOR_PATCH);
  await ctx.route("**/config.js", (r) => r.fulfill({ contentType: "application/javascript", body: TEST_CONFIG }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${page.url()} :: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  return page;
}

async function adminLogin(page, acct) {
  await page.goto(`${BASE}/`);
  await page.fill("#loginEmail", acct.email);
  await page.fill("#loginPassword", acct.password);
  await page.click("#loginForm button[type=submit]");
}
async function employeeLogin(page, acct) {
  await page.goto(`${BASE}/employee.html`);
  await page.fill("#empLoginEmail", acct.email);
  await page.fill("#empLoginPassword", acct.password);
  await page.click("#empLoginForm button[type=submit]");
}
const visible = (page, sel) => page.locator(sel).isVisible();
const hasHiddenClass = (page, sel) => page.locator(sel).evaluate((e) => e.classList.contains("hidden"));
// textContent (not innerText) so hidden elements such as #liveOutput can be read too.
const text = async (page, sel) => (await page.locator(sel).first().textContent()).trim();

// The scan input / Connect button live inside a hidden <div> in index.html (the ESP32 now posts to
// Firestore itself), so call the app's own processScan() exactly as the hidden button would.
async function scan(page, uid) {
  return page.evaluate((u) => processScan(u, "manual").then(() => "ok", (e) => `error: ${e.code || e.message}`), uid);
}

async function readAttendance(uid) {
  const env = await getEnv();
  let rows = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().collection("attendance").where("uid", "==", uid).get();
    rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  });
  return rows;
}

describe("server.mjs", () => {
  test("serves both pages, static assets, dynamic /config.js, and blocks path traversal", async () => {
    const get = (p) => fetch(`${BASE}${p}`);
    assert.equal((await get("/")).status, 200);
    assert.match(await (await get("/")).text(), /TechCADD/);
    assert.equal((await get("/employee.html")).status, 200);
    assert.equal((await get("/app.js")).status, 200);
    assert.equal((await get("/styles.css")).headers.get("content-type").split(";")[0], "text/css");
    const cfg = await get("/config.js");
    assert.equal(cfg.status, 200);
    assert.match(await cfg.text(), /^window\.__APP_CONFIG__ = \{/);
    assert.equal((await get("/nope.js")).status, 404, "missing asset with extension → 404");
    assert.equal((await get("/some/route")).status, 200, "extension-less unknown route falls back to index.html");
    // raw sockets: fetch() normalises ../ away, so send the traversal untouched
    const net = await import("node:net");
    const status = await new Promise((resolve) => {
      const s = net.connect(PORT, "127.0.0.1", () => s.write("GET /../server.mjs HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      let buf = "";
      s.on("data", (d) => (buf += d));
      s.on("close", () => resolve(buf.split("\r\n")[0]));
    });
    assert.match(status, /40[34]/, `path traversal must not be served, got: ${status}`);
    const leak = await get("/..%2fserver.mjs");
    assert.notEqual((await leak.text()).includes("createServer"), true, "server source leaked via encoded traversal");
  });
});

describe("Super Admin login (index.html)", () => {
  test("logs in, sees full navigation, Users panel and role badge", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForSelector("#appShell:not(.hidden)");
    assert.equal(await text(page, "#roleStatusPill"), "Super Admin");
    assert.equal(await hasHiddenClass(page, "#usersNavLink"), false, "Users nav must be shown to super_admin");
    assert.equal(await hasHiddenClass(page, "#sampleDataBtn"), false, "sample-data button must be shown to super_admin");
    assert.equal(await text(page, "#currentUserLabel"), ACCOUNTS.admin.email);
    // Employees list is populated from Firestore
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
  });

  test("wrong password shows an error and stays on the login screen", async () => {
    const page = await newPage();
    await adminLogin(page, { ...ACCOUNTS.admin, password: "totally-wrong" });
    await page.waitForFunction(() => document.querySelector("#loginHint").textContent !== "Sign in with your account.");
    assert.equal(await visible(page, "#appShell"), false);
    assert.match(await text(page, "#loginHint"), /incorrect|not found|credentials/i);
  });

  test("session persists across reload", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForSelector("#appShell:not(.hidden)");
    await page.reload();
    await page.waitForSelector("#appShell:not(.hidden)");
    assert.equal(await text(page, "#roleStatusPill"), "Super Admin");
  });

  test("sign out returns to the login screen", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForSelector("#appShell:not(.hidden)");
    await page.click("#signOutBtn");
    await page.waitForSelector("#loginView:not(.hidden)");
    assert.equal(await visible(page, "#appShell"), false);
  });

  test("scan flow from the dashboard: check-in → check-out → already done", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");

    await scan(page, "A1B2C3D4");
    await page.waitForFunction(() => document.querySelector("#liveOutput").textContent.includes("CHECK_IN"));
    let rows = await readAttendance("A1B2C3D4");
    assert.equal(rows.length, 1, "one attendance doc written");
    assert.ok(rows[0].checkIn && !rows[0].checkOut);
    assert.equal(rows[0].employeeName, "John Smith");

    await scan(page, "A1B2C3D4");
    await page.waitForFunction(() => document.querySelector("#liveOutput").textContent.includes("CHECK_OUT"));
    rows = await readAttendance("A1B2C3D4");
    assert.ok(rows[0].checkOut, "check-out persisted");

    await scan(page, "A1B2C3D4");
    await page.waitForFunction(() => document.querySelector("#liveOutput").textContent.includes("ALREADY_DONE"));

    await scan(page, "FFFFFFFF");
    await page.waitForFunction(() => document.querySelector("#liveOutput").textContent.includes("UNKNOWN CARD"));
  });

  test("Users panel: super admin creates an HR login that can then sign in", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForSelector("#appShell:not(.hidden)");
    await page.goto(`${BASE}/#/users`);
    await page.waitForSelector("#usersView.is-active");
    await page.fill("#userName", "Created HR");
    await page.fill("#userEmail", "created-hr@test.local");
    await page.fill("#userPassword", "Created#123");
    await page.selectOption("#userRole", "hr");
    await page.click("#createUserBtn");
    await page.waitForFunction(() => /Login created|already|Failed|must|Invalid/i.test(document.querySelector("#userFormHint").textContent));
    assert.match(await text(page, "#userFormHint"), /Login created/);
    await page.waitForFunction(() => document.querySelector("#usersTableBody").textContent.includes("created-hr@test.local"));
    // admin must still be signed in as admin (secondary app must not hijack the session)
    assert.equal(await text(page, "#currentUserLabel"), ACCOUNTS.admin.email);

    const hr = await newPage();
    await adminLogin(hr, { email: "created-hr@test.local", password: "Created#123" });
    await hr.waitForSelector("#appShell:not(.hidden)");
    assert.equal(await text(hr, "#roleStatusPill"), "HR");
  });

  test("Users panel: super admin creates an EMPLOYEE login that can use the portal", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForSelector("#appShell:not(.hidden)");
    await page.goto(`${BASE}/#/users`);
    await page.waitForSelector("#usersView.is-active");
    await page.fill("#userName", "Mike W");
    await page.fill("#userEmail", "mike@test.local");
    await page.fill("#userPassword", "Mike#12345");
    await page.selectOption("#userRole", "employee");
    await page.selectOption("#userEmployeeLink", "I9J0K1L2");
    await page.click("#createUserBtn");
    await page.waitForFunction(() => /Login created|already|Failed|must|Invalid/i.test(document.querySelector("#userFormHint").textContent));
    assert.match(await text(page, "#userFormHint"), /Login created/);

    const emp = await newPage();
    await employeeLogin(emp, { email: "mike@test.local", password: "Mike#12345" });
    await emp.waitForSelector("#empDashboard:not(.hidden)");
    assert.match(await text(emp, "#empWelcome"), /Mike Wilson/);
  });

  test("Edit Time: super admin can rewrite a recorded check-in and check-out", async () => {
    const env = await getEnv();
    const day = todayLocalKey();
    await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`attendance/${day}_A1B2C3D4`).set({
      uid: "A1B2C3D4", dateKey: day, employeeId: "EMP001", employeeName: "John Smith", checkIn: "09:00:00", checkOut: "17:00:00",
    }));
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForSelector("#appShell:not(.hidden)");
    await page.goto(`${BASE}/#/attendance/today`);
    await page.waitForSelector("[data-edit-time], .edit-time-btn, button:has-text('Edit Time')");
    await page.locator("[data-edit-time], .edit-time-btn, button:has-text('Edit Time')").first().click();
    await page.waitForSelector("#editTimeModal:not(.hidden)");
    await page.fill("#editTimeCheckIn", "08:15:00");
    await page.fill("#editTimeCheckOut", "16:45:00");
    await page.click("#saveEditTimeBtn");
    await page.waitForSelector("#editTimeModal.hidden", { state: "attached" });
    const [row] = await readAttendance("A1B2C3D4");
    assert.equal(row.checkIn, "08:15:00");
    assert.equal(row.checkOut, "16:45:00");
  });
});

describe("HR login (index.html)", () => {
  test("logs in as HR: Users (employee logins) yes, Devices no, no sample-data button, badge says HR", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.hr);
    await page.waitForSelector("#appShell:not(.hidden)");
    assert.equal(await text(page, "#roleStatusPill"), "HR");
    assert.equal(await hasHiddenClass(page, "#usersNavLink"), false, "HR makes employee logins, so Users must be shown");
    assert.equal(await hasHiddenClass(page, "#devicesNavLink"), true, "Devices is Super Admin only");
    assert.equal(await hasHiddenClass(page, "#sampleDataBtn"), true, "sample-data button must be hidden from HR");
  });
  test("HR can open #/users, but #/devices sends them back to the dashboard", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.hr);
    await page.waitForSelector("#appShell:not(.hidden)");
    await page.goto(`${BASE}/#/users`);
    await page.waitForSelector("#usersView.is-active");
    await page.goto(`${BASE}/#/devices`);
    await page.waitForTimeout(500);
    assert.equal(await visible(page, "#devicesView.is-active"), false);
  });

  test("HR can add an employee and run the scan flow", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.hr);
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await page.goto(`${BASE}/#/employees`);
    await page.waitForSelector("#employeeAddView.is-active");
    await page.fill("#employeeUid", "CAFEBABE");
    await page.fill("#employeeId", "EMP100");
    await page.fill("#employeeName", "New Person");
    await page.fill("#employeeBranch", "Delhi HQ");
    await page.fill("#employeeDepartment", "Ops");
    await page.fill("#employeeRole", "Analyst");
    await page.click("#employeeForm button[type=submit]");
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "4");

    await page.goto(`${BASE}/#/dashboard`);
    await scan(page, "CAFEBABE");
    await page.waitForFunction(() => document.querySelector("#liveOutput").textContent.includes("CHECK_IN"));
    await scan(page, "CAFEBABE");
    await page.waitForFunction(() => document.querySelector("#liveOutput").textContent.includes("CHECK_OUT"));
    const [row] = await readAttendance("CAFEBABE");
    assert.ok(row.checkIn && row.checkOut);
  });

  test("HR has no Edit Time or Delete-employee controls", async () => {
    const env = await getEnv();
    const day = todayLocalKey();
    await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`attendance/${day}_A1B2C3D4`).set({
      uid: "A1B2C3D4", dateKey: day, checkIn: "09:00:00", checkOut: "17:00:00",
    }));
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.hr);
    await page.waitForSelector("#appShell:not(.hidden)");
    await page.goto(`${BASE}/#/attendance/today`);
    await page.waitForFunction(() => document.querySelector("#todayAttendanceBody").textContent.includes("9:00 AM"));
    assert.equal(await page.locator("button:has-text('Edit Time')").count(), 0);
    await page.goto(`${BASE}/#/employees/manager`);
    await page.waitForSelector("#managerView.is-active");
    assert.equal(await page.locator("#employeeTableBody button:has-text('Delete')").count(), 0, "HR must not see Delete");
  });

  test("HR cannot delete an employee even by calling Firestore directly (rules enforce it)", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.hr);
    await page.waitForSelector("#appShell:not(.hidden)");
    const result = await page.evaluate(async () => {
      try { await firebase.firestore().collection("employees").doc("A1B2C3D4").delete(); return "deleted"; }
      catch (e) { return e.code; }
    });
    assert.equal(result, "permission-denied");
  });
});

describe("Employee login (employee.html)", () => {
  test("logs in, sees own profile only", async () => {
    const page = await newPage();
    await employeeLogin(page, ACCOUNTS.emp);
    await page.waitForSelector("#empDashboard:not(.hidden)");
    assert.match(await text(page, "#empWelcome"), /John Smith/);
    assert.match(await text(page, "#empProfileGrid"), /EMP001/);
    assert.match(await text(page, "#empTodayStatus"), /haven't tapped/i);
  });

  test("wrong password is rejected", async () => {
    const page = await newPage();
    await employeeLogin(page, { ...ACCOUNTS.emp, password: "nope-nope" });
    await page.waitForFunction(() => /incorrect|unable/i.test(document.querySelector("#empLoginHint").textContent));
    assert.equal(await visible(page, "#empDashboard"), false);
  });

  test("staff (HR) login on the employee portal is refused", async () => {
    const page = await newPage();
    await employeeLogin(page, ACCOUNTS.hr);
    await page.waitForFunction(() => /not set up as an employee/i.test(document.querySelector("#empLoginHint").textContent));
    assert.equal(await visible(page, "#empDashboard"), false);
  });

  test("employee login on the STAFF dashboard is refused", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.emp);
    await page.waitForFunction(() => /staff only/i.test(document.querySelector("#loginHint").textContent));
    assert.equal(await visible(page, "#appShell"), false);
  });

  test("login with no role doc is refused on both apps", async () => {
    const a = await newPage();
    await adminLogin(a, ACCOUNTS.norole);
    await a.waitForFunction(() => /not set up/i.test(document.querySelector("#loginHint").textContent));
    const b = await newPage();
    await employeeLogin(b, ACCOUNTS.norole);
    await b.waitForFunction(() => /not set up/i.test(document.querySelector("#empLoginHint").textContent));
  });

  test("after a card tap: status becomes Location Needed → Verify My Location → confirmed", async () => {
    const admin = await newPage({ geolocation: null });
    await adminLogin(admin, ACCOUNTS.hr);
    await admin.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    // HR browser has geolocation blocked, so the check-in carries no location (like a hardware tap)
    await scan(admin, "A1B2C3D4");
    await admin.waitForFunction(() => document.querySelector("#liveOutput").textContent.includes("CHECK_IN"));

    const page = await newPage();
    await employeeLogin(page, ACCOUNTS.emp);
    await page.waitForSelector("#empDashboard:not(.hidden)");
    await page.waitForFunction(() => document.querySelector("#empAttendanceBody").textContent.includes("-") &&
      document.querySelectorAll("#empAttendanceBody tr").length >= 1);
    await page.waitForSelector("#empScanWrap:not(.hidden)");
    await page.click("#empScanBtn");
    await page.waitForFunction(() => /location confirmed/i.test(document.querySelector("#empTodayStatus").textContent));
    const [row] = await readAttendance("A1B2C3D4");
    assert.ok(row.checkInLocation && typeof row.checkInLocation.lat === "number");
    assert.ok(row.checkInLocationAt, "capture timestamp stored");
  });

  test("employee cannot see other employees' records", async () => {
    const env = await getEnv();
    const day = todayLocalKey();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`attendance/${day}_E5F6G7H8`).set({ uid: "E5F6G7H8", dateKey: day, checkIn: "09:30:00", checkOut: null });
    });
    const page = await newPage();
    await employeeLogin(page, ACCOUNTS.emp);
    await page.waitForSelector("#empDashboard:not(.hidden)");
    const res = await page.evaluate(async () => {
      try { const s = await firebase.firestore().collection("attendance").get(); return `read ${s.size}`; }
      catch (e) { return e.code; }
    });
    assert.equal(res, "permission-denied");
    assert.ok(!(await text(page, "#empAttendanceBody")).includes("09:30"));
  });
});

describe("cross-role data integrity", () => {
  test("HR check-out from the dashboard must not erase location proof the employee already captured", async () => {
    const hr = await newPage({ geolocation: null });
    await adminLogin(hr, ACCOUNTS.hr);
    await hr.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await scan(hr, "A1B2C3D4");
    await hr.waitForFunction(() => document.querySelector("#liveOutput").textContent.includes("CHECK_IN"));

    const emp = await newPage();
    await employeeLogin(emp, ACCOUNTS.emp);
    await emp.waitForSelector("#empScanWrap:not(.hidden)");
    await emp.click("#empScanBtn");
    await emp.waitForFunction(() => /location confirmed/i.test(document.querySelector("#empTodayStatus").textContent));
    assert.ok((await readAttendance("A1B2C3D4"))[0].checkInLocationAt, "precondition: capture timestamp stored");

    await scan(hr, "A1B2C3D4"); // check-out
    await hr.waitForFunction(() => document.querySelector("#liveOutput").textContent.includes("CHECK_OUT"));
    const [row] = await readAttendance("A1B2C3D4");
    assert.ok(row.checkOut, "check-out saved");
    assert.ok(row.checkInLocationAt, "checkInLocationAt (employee's verification timestamp) was wiped by the dashboard's full-document set()");
  });

  test("employee 'Delete Check-Out' then HR re-scan works end to end", async () => {
    const hr = await newPage({ geolocation: null });
    await adminLogin(hr, ACCOUNTS.hr);
    await hr.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await scan(hr, "A1B2C3D4");
    await hr.waitForFunction(() => document.querySelector("#liveOutput").textContent.includes("CHECK_IN"));
    await scan(hr, "A1B2C3D4");
    await hr.waitForFunction(() => document.querySelector("#liveOutput").textContent.includes("CHECK_OUT"));

    const emp = await newPage();
    await employeeLogin(emp, ACCOUNTS.emp);
    await emp.waitForSelector("#empDeleteWrap:not(.hidden)");
    await emp.click("#empDeleteBtn");
    await emp.waitForFunction(() => /Check-out deleted/i.test(document.querySelector("#empScanHint").textContent));
    assert.equal((await readAttendance("A1B2C3D4"))[0].checkOut, undefined);

    const outcome = await scan(hr, "A1B2C3D4"); // portal promises: "Tap your card again to check out."
    assert.equal(outcome, "ok", `re-scan after the employee's undo was rejected (${outcome})`);
    assert.ok((await readAttendance("A1B2C3D4"))[0].checkOut, "check-out re-recorded");
  });
});

describe("timezone: dashboard date vs hardware/local date (India, UTC+5:30)", () => {
  // Firmware writes dateKey from LOCAL time (configTime GMT+5:30). app.js todayKey() must use LOCAL time too (it used toISOString(), i.e. UTC).
  test("at 02:00 IST on 22 Sep the dashboard's 'today' must be 2026-09-22", async () => {
    const page = await newPage({ timezoneId: "Asia/Kolkata" });
    await page.clock.install({ time: new Date("2026-09-22T02:00:00+05:30") });
    await page.goto(`${BASE}/`);
    const today = await page.evaluate(() => todayKey());
    assert.equal(today, "2026-09-22", `todayKey() returned ${today}`);
  });
  test("at 02:00 IST the employee portal's 'today' must match too", async () => {
    const page = await newPage({ timezoneId: "Asia/Kolkata" });
    await page.clock.install({ time: new Date("2026-09-22T02:00:00+05:30") });
    await page.goto(`${BASE}/employee.html`);
    const today = await page.evaluate(() => todayKey());
    assert.equal(today, "2026-09-22", `todayKey() returned ${today}`);
  });
});

describe("dashboard metrics", () => {
  test("'Late Today' tile counts check-ins after each employee's shift start; Present/Checked Out split correctly", async () => {
    const env = await getEnv();
    const probe = await newPage();
    await probe.goto(`${BASE}/`);
    const day = await probe.evaluate(() => todayKey());
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc(`attendance/${day}_A1B2C3D4`).set({ uid: "A1B2C3D4", dateKey: day, checkIn: "09:00:00", checkOut: null });
      await db.doc(`attendance/${day}_E5F6G7H8`).set({ uid: "E5F6G7H8", dateKey: day, checkIn: "09:45:00", checkOut: null });
      await db.doc(`attendance/${day}_I9J0K1L2`).set({ uid: "I9J0K1L2", dateKey: day, checkIn: "10:30:00", checkOut: null });
    });
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForFunction(() => document.querySelector("#metricPresent").textContent === "3");
    assert.equal(await text(page, "#metricLate"), "2", "09:45 and 10:30 are late for the default 9:00 shift; 09:00 is on time");
    assert.equal(await text(page, "#metricCheckedOut"), "0");
  });
});

// ---- Role duties, as specified by the owner ------------------------------------------------------
//  HR:          add employee, assign a card, see attendance, make remarks.
//  Super Admin: see every employee / HR login / branch, edit ANY employee's time, check leaves.
async function addEmployeeViaForm(page, e) {
  await page.goto(`${BASE}/#/employees`);
  await page.waitForSelector("#employeeAddView.is-active");
  await page.fill("#employeeUid", e.uid);
  await page.fill("#employeeId", e.id);
  await page.fill("#employeeName", e.name);
  await page.fill("#employeeBranch", e.branch || "Delhi HQ");
  await page.fill("#employeeDepartment", "Ops");
  await page.fill("#employeeRole", "Analyst");
  await page.click("#employeeForm button[type=submit]");
}
async function readEmployee(uid) {
  const env = await getEnv();
  let data;
  await env.withSecurityRulesDisabled(async (ctx) => { data = (await ctx.firestore().doc(`employees/${uid}`).get()).data(); });
  return data;
}

describe("HR duties: add employee, assign card, see attendance, make remarks", () => {
  test("HR adds an employee with a new card UID and it shows in the Manager list", async () => {
    const page = await newPage({ geolocation: null });
    await adminLogin(page, ACCOUNTS.hr);
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await addEmployeeViaForm(page, { uid: "cafe0001", id: "EMP100", name: "New Hire", branch: "Chennai" });
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "4");
    let saved;
    for (let i = 0; i < 30 && !saved; i++) { saved = await readEmployee("CAFE0001"); if (!saved) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(saved, "employee doc CAFE0001 (UID upper-cased from 'cafe0001') was never written");
    assert.equal(saved.name, "New Hire");
    assert.equal(saved.branch, "Chennai");
    await page.goto(`${BASE}/#/employees/manager`);
    await page.waitForFunction(() => document.querySelector("#employeeTableBody").textContent.includes("New Hire"));
  });

  test("assigning a card UID that already belongs to another employee is rejected (must not overwrite them)", async () => {
    const page = await newPage({ geolocation: null });
    await adminLogin(page, ACCOUNTS.hr);
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await addEmployeeViaForm(page, { uid: "A1B2C3D4", id: "EMP200", name: "Someone Else" });
    await page.waitForTimeout(800);
    const john = await readEmployee("A1B2C3D4");
    assert.equal(john.name, "John Smith", `card A1B2C3D4 belonged to John Smith but is now assigned to "${john.name}" (${john.employeeId})`);
  });

  test("a new employee cannot reuse an existing Employee ID", async () => {
    const page = await newPage({ geolocation: null });
    await adminLogin(page, ACCOUNTS.hr);
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await addEmployeeViaForm(page, { uid: "CAFE0002", id: "EMP001", name: "Duplicate Id" });
    await page.waitForTimeout(800);
    assert.equal(await readEmployee("CAFE0002"), undefined, "two employees now share Employee ID EMP001");
  });

  test("HR sees attendance history (all-records page and today page)", async () => {
    const env = await getEnv();
    const probe = await newPage();
    await probe.goto(`${BASE}/`);
    const day = await probe.evaluate(() => todayKey());
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`attendance/${day}_A1B2C3D4`).set({ uid: "A1B2C3D4", dateKey: day, employeeName: "John Smith", checkIn: "09:00:00", checkOut: "17:30:00" });
      await ctx.firestore().doc("attendance/2026-09-01_E5F6G7H8").set({ uid: "E5F6G7H8", dateKey: "2026-09-01", employeeName: "Sarah Johnson", checkIn: "09:45:00", checkOut: "18:00:00" });
    });
    const page = await newPage({ geolocation: null });
    await adminLogin(page, ACCOUNTS.hr);
    await page.waitForSelector("#appShell:not(.hidden)");
    await page.goto(`${BASE}/#/attendance`);
    await page.waitForFunction(() => document.querySelector("#attendanceTableBody").textContent.includes("Sarah Johnson"));
    const t = await text(page, "#attendanceTableBody");
    assert.match(t, /John Smith/);
    assert.match(t, /8h 30m/, "hours worked calculated");
    await page.goto(`${BASE}/#/attendance/today`);
    await page.waitForFunction(() => document.querySelector("#todayAttendanceBody").textContent.includes("John Smith"));
  });

  test("HR adds a remark on an employee; it is stored, listed, and visible to the Super Admin", async () => {
    const hr = await newPage({ geolocation: null });
    await adminLogin(hr, ACCOUNTS.hr);
    await hr.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await hr.evaluate(() => openEmployeeDrawer("A1B2C3D4"));
    await hr.fill("#drawerRemarkInput", "Client visit at Bangalore site");
    await hr.click("#drawerAddRemarkBtn");
    await hr.waitForFunction(() => document.querySelector("#drawerRemarkList").textContent.includes("Client visit"));
    const env = await getEnv();
    let remarks = [];
    await env.withSecurityRulesDisabled(async (ctx) => {
      remarks = (await ctx.firestore().collection("remarks").where("uid", "==", "A1B2C3D4").get()).docs.map((d) => d.data());
    });
    assert.equal(remarks.length, 1);
    assert.equal(remarks[0].text, "Client visit at Bangalore site");

    const admin = await newPage();
    await adminLogin(admin, ACCOUNTS.admin);
    await admin.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await admin.evaluate(() => openEmployeeDrawer("A1B2C3D4"));
    await admin.waitForFunction(() => document.querySelector("#drawerRemarkList").textContent.includes("Client visit"));
  });

  test("an empty remark is ignored", async () => {
    const hr = await newPage({ geolocation: null });
    await adminLogin(hr, ACCOUNTS.hr);
    await hr.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await hr.evaluate(() => openEmployeeDrawer("A1B2C3D4"));
    await hr.fill("#drawerRemarkInput", "   ");
    await hr.click("#drawerAddRemarkBtn");
    await hr.waitForTimeout(500);
    const env = await getEnv();
    let n = -1;
    await env.withSecurityRulesDisabled(async (ctx) => { n = (await ctx.firestore().collection("remarks").get()).size; });
    assert.equal(n, 0);
  });
});

describe("Super Admin duties: see everything, edit any time, check leaves", () => {
  test("sees all employees and the HR / other logins", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await page.goto(`${BASE}/#/employees/manager`);
    await page.waitForFunction(() => document.querySelectorAll("#employeeTableBody tr").length === 3);
    await page.goto(`${BASE}/#/users`);
    await page.waitForFunction(() => document.querySelector("#usersTableBody").textContent.includes("hr@test.local"));
    const users = await text(page, "#usersTableBody");
    for (const a of [ACCOUNTS.admin, ACCOUNTS.hr, ACCOUNTS.emp, ACCOUNTS.device]) assert.ok(users.includes(a.email), `Users panel is missing ${a.email}`);
  });

  test("can filter the employee list by branch", async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc("employees/A1B2C3D4").set({ branch: "Delhi HQ" }, { merge: true });
      await db.doc("employees/E5F6G7H8").set({ branch: "Chennai" }, { merge: true });
      await db.doc("employees/I9J0K1L2").set({ branch: "Chennai" }, { merge: true });
    });
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await page.goto(`${BASE}/#/employees/manager`);
    await page.fill("#employeeSearchInput", "Chennai");
    await page.waitForFunction(() => document.querySelectorAll("#employeeTableBody tr").length === 2);
  });

  test("has a branch overview (employees grouped / counted per branch)", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForSelector("#appShell:not(.hidden)");
    const nav = (await page.locator(".sidebar-nav").textContent()).toLowerCase();
    const hasBranchUi = nav.includes("branch") || (await page.locator("select[id*=ranch], [id*=ranchFilter], [id*=ranchSummary]").count()) > 0;
    assert.ok(hasBranchUi, "no branch page, branch filter or per-branch summary exists (branch is only a text column)");
  });

  test("can edit ANY employee's time, including adding a time for a day with no record (forgot to tap)", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    const opened = await page.evaluate(() => {
      openEditTimeModal("2026-09-15", "E5F6G7H8"); // Sarah has no attendance record on this day
      return !document.getElementById("editTimeModal").classList.contains("hidden");
    });
    assert.equal(opened, true, "Edit Time only works on existing records; a missing day cannot be filled in");
  });

  test("has leave management (apply / approve / view leaves)", async () => {
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForSelector("#appShell:not(.hidden)");
    const nav = (await page.locator(".sidebar-nav").textContent()).toLowerCase();
    assert.ok(/leave/.test(nav), "there is no Leave page in the navigation");
    assert.match(await (await fetch(`${BASE}/app.js`)).text(), /collection\(["']leaves?["']\)/, "no Firestore 'leaves' collection is used");
  });
});

// ---- Login matrix: every account x both login pages -------------------------------------------
// staff page = index.html (super_admin + hr only); employee page = employee.html (employee only).
async function tryLogin(page, target, email, password) {
  const staff = target === "staff";
  await page.goto(`${BASE}${staff ? "/" : "/employee.html"}`);
  await page.fill(staff ? "#loginEmail" : "#empLoginEmail", email);
  await page.fill(staff ? "#loginPassword" : "#empLoginPassword", password);
  await page.keyboard.press("Enter"); // also proves Enter submits the form
  await page.waitForFunction((s) => {
    const shown = s ? !document.getElementById("appShell").classList.contains("hidden") : !document.getElementById("empDashboard").classList.contains("hidden");
    const hint = document.getElementById(s ? "loginHint" : "empLoginHint").textContent;
    return shown || /incorrect|unable|not set up|not found|invalid|too many|staff only|not configured/i.test(hint);
  }, staff, { timeout: 15000 });
  await page.waitForTimeout(300); // let any post-login sign-out (refused role) settle
  const loggedIn = staff ? await visible(page, "#appShell") : await visible(page, "#empDashboard");
  const hint = (await text(page, staff ? "#loginHint" : "#empLoginHint")) || "";
  const who = loggedIn ? await text(page, staff ? "#roleStatusPill" : "#empWelcome") : null;
  return { loggedIn, hint, who };
}

describe("LOGIN MATRIX", () => {
  const A = ACCOUNTS;
  const cases = [
    // [account, page, shouldLogIn, expected role/name text, expected refusal message]
    ["admin",  "staff",    true,  /Super Admin/],
    ["hr",     "staff",    true,  /^HR$/],
    ["emp",    "staff",    false, null, /staff only/i],
    ["emp2",   "staff",    false, null, /staff only/i],
    ["device", "staff",    false, null, /staff only/i],
    ["norole", "staff",    false, null, /not set up/i],
    ["emp",    "employee", true,  /John Smith/],
    ["emp2",   "employee", true,  /Sarah Johnson/],
    ["admin",  "employee", false, null, /not set up as an employee/i],
    ["hr",     "employee", false, null, /not set up as an employee/i],
    ["device", "employee", false, null, /not set up as an employee/i],
    ["norole", "employee", false, null, /not set up|not set up as an employee/i],
  ];
  for (const [key, target, ok, who, refusal] of cases) {
    test(`${key.padEnd(6)} on ${target.padEnd(8)} page -> ${ok ? "LOGGED IN" : "REFUSED"}`, async () => {
      const page = await newPage({ geolocation: null });
      const r = await tryLogin(page, target, A[key].email, A[key].password);
      assert.equal(r.loggedIn, ok, `expected loggedIn=${ok}, got ${JSON.stringify(r)}`);
      if (ok) assert.match(r.who, who);
      else assert.match(r.hint, refusal, `refusal message was: "${r.hint}"`);
    });
  }

  for (const target of ["staff", "employee"]) {
    for (const key of target === "staff" ? ["admin", "hr"] : ["emp", "emp2"]) {
      test(`${key} on ${target}: WRONG password is rejected`, async () => {
        const page = await newPage({ geolocation: null });
        const r = await tryLogin(page, target, A[key].email, "definitely-wrong");
        assert.equal(r.loggedIn, false);
        assert.match(r.hint, /incorrect|not found|unable/i);
      });
    }
    test(`unknown email on ${target} page is rejected`, async () => {
      const page = await newPage({ geolocation: null });
      const r = await tryLogin(page, target, "nobody@test.local", "Whatever#123");
      assert.equal(r.loggedIn, false);
      assert.match(r.hint, /incorrect|not found|unable/i);
    });
    test(`email is trimmed and case-insensitive on ${target} page`, async () => {
      const page = await newPage({ geolocation: null });
      const acct = target === "staff" ? A.admin : A.emp;
      const r = await tryLogin(page, target, `  ${acct.email.toUpperCase()}  `, acct.password);
      assert.equal(r.loggedIn, true, JSON.stringify(r));
    });
    test(`empty fields on ${target} page do not sign anyone in`, async () => {
      const page = await newPage({ geolocation: null });
      await page.goto(`${BASE}${target === "staff" ? "/" : "/employee.html"}`);
      await page.click(target === "staff" ? "#loginForm button[type=submit]" : "#empLoginForm button[type=submit]");
      await page.waitForTimeout(500);
      assert.equal(await visible(page, target === "staff" ? "#appShell" : "#empDashboard"), false);
    });
  }

  test("session survives reload for HR and employee too, and sign-out really ends it", async () => {
    const hr = await newPage({ geolocation: null });
    assert.equal((await tryLogin(hr, "staff", A.hr.email, A.hr.password)).loggedIn, true);
    await hr.reload();
    await hr.waitForSelector("#appShell:not(.hidden)");
    await hr.click("#signOutBtn");
    await hr.waitForSelector("#loginView:not(.hidden)");
    await hr.reload();
    await hr.waitForSelector("#loginView:not(.hidden)");
    assert.equal(await visible(hr, "#appShell"), false, "still signed in after sign-out + reload");

    const emp = await newPage({ geolocation: null });
    assert.equal((await tryLogin(emp, "employee", A.emp.email, A.emp.password)).loggedIn, true);
    await emp.reload();
    await emp.waitForSelector("#empDashboard:not(.hidden)");
    await emp.click("#empLogoutBtn");
    await emp.waitForSelector("#empLoginView:not(.hidden)");
    await emp.reload();
    await emp.waitForSelector("#empLoginView:not(.hidden)");
    assert.equal(await visible(emp, "#empDashboard"), false, "still signed in after logout + reload");
  });

  test("after sign-out the previous user's data is gone from the page (no leak to the next login)", async () => {
    const page = await newPage({ geolocation: null });
    assert.equal((await tryLogin(page, "employee", A.emp.email, A.emp.password)).loggedIn, true);
    await page.click("#empLogoutBtn");
    await page.waitForSelector("#empLoginView:not(.hidden)");
    assert.equal(await page.locator("#empLoginEmail").inputValue(), "");
    assert.equal(await page.locator("#empLoginPassword").inputValue(), "");
    // now log in as the OTHER employee on the same page and make sure it's Sarah, not John
    await page.fill("#empLoginEmail", A.emp2.email);
    await page.fill("#empLoginPassword", A.emp2.password);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#empDashboard:not(.hidden)");
    await page.waitForFunction(() => document.querySelector("#empWelcome").textContent.includes("Sarah"));
    assert.doesNotMatch(await text(page, "#empProfileGrid"), /EMP001|John/);
  });

  test("an account whose role is revoked while signed in loses access on next load", async () => {
    const page = await newPage({ geolocation: null });
    assert.equal((await tryLogin(page, "staff", A.hr.email, A.hr.password)).loggedIn, true);
    const env = await getEnv();
    await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`users/${uids.hr}`).delete());
    await page.reload();
    await page.waitForFunction(() => !document.getElementById("loginView").classList.contains("hidden"), null, { timeout: 15000 });
    assert.equal(await visible(page, "#appShell"), false, "revoked HR can still see the dashboard");
  });
});

describe("CHAIN: Super Admin makes an HR, the HR makes an employee, the employee signs in", () => {
  async function fillUserForm(page, { name, email, password, employeeUid }) {
    await page.fill("#userName", name);
    await page.fill("#userEmail", email);
    await page.fill("#userPassword", password);
    if (employeeUid) await page.selectOption("#userEmployeeLink", employeeUid);
    await page.click("#createUserBtn");
    await page.waitForFunction(() => /Login created|already|not allowed|must|Invalid|Select|Please|Failed/i.test(document.querySelector("#userFormHint").textContent));
  }

  test("the whole chain works through the real screens", async () => {
    // every wait names its step so a failure says exactly where the chain broke
    const step = async (label, promise) => {
      try { return await promise; } catch (e) { throw new Error(`STEP "${label}": ${String(e.message).split("\n")[0]}`); }
    };
    const until = (page, label, fn, arg) => step(label, page.waitForFunction(fn, arg, { timeout: 15000 }));

    // 1. Super Admin creates an HR login
    const admin = await newPage();
    await adminLogin(admin, ACCOUNTS.admin);
    await until(admin, "admin sees 3 employees", () => document.querySelector("#metricEmployees").textContent === "3");
    await admin.goto(`${BASE}/#/users`);
    await step("admin opens Users", admin.waitForSelector("#usersView.is-active", { timeout: 15000 }));
    assert.deepEqual((await admin.locator("#userRole option").evaluateAll((o) => o.map((x) => x.value))).sort(), ["employee", "hr", "super_admin"]);
    await admin.selectOption("#userRole", "hr");
    await fillUserForm(admin, { name: "Priya HR", email: "priya.hr@test.local", password: "PriyaHR#123" });
    assert.match(await text(admin, "#userFormHint"), /Login created/, "admin creating the HR login");

    // 2. That HR signs in: Users panel is there, but only for employee logins
    const hr = await newPage({ geolocation: null });
    const r = await tryLogin(hr, "staff", "priya.hr@test.local", "PriyaHR#123");
    assert.equal(r.loggedIn, true, JSON.stringify(r));
    assert.equal(r.who, "HR");
    assert.equal(await hasHiddenClass(hr, "#usersNavLink"), false);
    await until(hr, "HR sees 3 employees", () => document.querySelector("#metricEmployees").textContent === "3");
    await hr.goto(`${BASE}/#/users`);
    await step("HR opens Users", hr.waitForSelector("#usersView.is-active", { timeout: 15000 }));
    assert.deepEqual(await hr.locator("#userRole option").evaluateAll((o) => o.map((x) => x.value)), ["employee"], "HR may only offer the employee role");
    assert.match(await text(hr, "#usersFormTitle"), /employee a login/i);
    await until(hr, "HR sees employee logins", () => document.querySelector("#usersTableBody").textContent.includes("john@test.local"));
    const listed = await text(hr, "#usersTableBody");
    for (const hidden of [ACCOUNTS.admin.email, ACCOUNTS.hr.email, "priya.hr@test.local", ACCOUNTS.device.email]) {
      assert.ok(!listed.includes(hidden), `HR can see a non-employee login: ${hidden}`);
    }

    // 3. HR adds a NEW employee (card) and gives them a login
    await addEmployeeViaForm(hr, { uid: "CAFE0100", id: "EMP100", name: "Fresh Hire", branch: "Chennai" });
    await until(hr, "HR sees 4 employees", () => document.querySelector("#metricEmployees").textContent === "4");
    await hr.goto(`${BASE}/#/users`);
    await until(hr, "new employee offered in the link list", () => [...document.querySelectorAll("#userEmployeeLink option")].some((o) => o.value === "CAFE0100"));
    await fillUserForm(hr, { name: "Fresh Hire", email: "fresh@test.local", password: "Fresh#12345", employeeUid: "CAFE0100" });
    assert.match(await text(hr, "#userFormHint"), /Login created/, "HR creating the employee login");
    await until(hr, "login appears in HR's list", () => document.querySelector("#usersTableBody").textContent.includes("fresh@test.local"));

    // 4. The new employee signs in to the portal and sees their own profile
    const emp = await newPage({ geolocation: null });
    const e = await tryLogin(emp, "employee", "fresh@test.local", "Fresh#12345");
    assert.equal(e.loggedIn, true, JSON.stringify(e));
    assert.match(e.who, /Fresh Hire/);
    assert.match(await text(emp, "#empProfileGrid"), /EMP100/);
  });

  test("HR cannot make an HR / admin login: the database refuses it and no orphan account is left behind", async () => {
    const hr = await newPage({ geolocation: null });
    assert.equal((await tryLogin(hr, "staff", ACCOUNTS.hr.email, ACCOUNTS.hr.password)).loggedIn, true);
    for (const role of ["hr", "super_admin", "device"]) {
      const email = `sneaky-${role}@test.local`;
      const res = await hr.evaluate((a) => createStaffAccount(a), { email, password: "Sneaky#12345", role, name: "Sneaky", employeeUid: "" });
      assert.equal(res.ok, false, `HR managed to create a ${role} login`);
      assert.match(res.message, /not allowed/i);
      // the half-created sign-in account must have been removed again (so the email is free)
      const probe = await newPage({ geolocation: null });
      const r = await tryLogin(probe, "staff", email, "Sneaky#12345");
      assert.equal(r.loggedIn, false);
      assert.doesNotMatch(r.hint, /not set up/i, `an orphan Auth account for ${email} was left behind`);
    }
    const env = await getEnv();
    let n = -1;
    await env.withSecurityRulesDisabled(async (ctx) => { n = (await ctx.firestore().collection("users").where("role", "==", "super_admin").get()).size; });
    assert.equal(n, 1, "only the original Super Admin exists");
  });

  test("a failed creation leaves the email free: HR can fix the mistake and retry", async () => {
    const hr = await newPage({ geolocation: null });
    assert.equal((await tryLogin(hr, "staff", ACCOUNTS.hr.email, ACCOUNTS.hr.password)).loggedIn, true);
    // first attempt links a card that does not exist -> refused
    const bad = await hr.evaluate((a) => createStaffAccount(a), { email: "retry@test.local", password: "Retry#12345", role: "employee", name: "Retry", employeeUid: "NO_SUCH_CARD" });
    assert.equal(bad.ok, false);
    // second attempt with the real employee works with the SAME email
    const good = await hr.evaluate((a) => createStaffAccount(a), { email: "retry@test.local", password: "Retry#12345", role: "employee", name: "Retry", employeeUid: "A1B2C3D4" });
    assert.equal(good.ok, true, JSON.stringify(good));
  });

  test("HR can revoke an employee login and that employee is locked out", async () => {
    const hr = await newPage({ geolocation: null });
    assert.equal((await tryLogin(hr, "staff", ACCOUNTS.hr.email, ACCOUNTS.hr.password)).loggedIn, true);
    await hr.goto(`${BASE}/#/users`);
    await hr.waitForFunction(() => document.querySelector("#usersTableBody").textContent.includes("john@test.local"));
    await hr.locator("#usersTableBody tr", { hasText: "john@test.local" }).locator("[data-revoke-user]").click();
    await hr.waitForFunction(() => !document.querySelector("#usersTableBody").textContent.includes("john@test.local"));
    const emp = await newPage({ geolocation: null });
    const r = await tryLogin(emp, "employee", ACCOUNTS.emp.email, ACCOUNTS.emp.password);
    assert.equal(r.loggedIn, false);
    assert.match(r.hint, /not set up/i);
  });

  test("the Super Admin still sees every login, including HR and devices", async () => {
    const admin = await newPage();
    await adminLogin(admin, ACCOUNTS.admin);
    await admin.waitForSelector("#appShell:not(.hidden)");
    await admin.goto(`${BASE}/#/users`);
    await admin.waitForFunction(() => document.querySelector("#usersTableBody").textContent.includes("hr@test.local"));
    const t = await text(admin, "#usersTableBody");
    for (const a of [ACCOUNTS.admin, ACCOUNTS.hr, ACCOUNTS.emp, ACCOUNTS.device]) assert.ok(t.includes(a.email), `missing ${a.email}`);
    assert.match(await text(admin, "#usersListTitle"), /Everyone who can sign in/);
  });
});

describe("Devices panel: approving ESP32 card readers (no password on the chip)", () => {
  // A real reader: anonymous sign-in + registering devices/{uid}, exactly like the firmware does.
  async function registerReader(name = "Front Door") {
    const su = await anonymousSignUp();
    const j = JSON.parse(su.text);
    const body = JSON.stringify({ fields: { name: { stringValue: name }, requestedAt: { stringValue: new Date().toISOString() } } });
    const w = await fsFetch(j.idToken, "PATCH", `devices/${j.localId}`, { body, query: "?currentDocument.exists=false" });
    assert.equal(w.code, 200, `reader could not register: ${w.text}`);
    return { uid: j.localId, token: j.idToken };
  }
  const readerCanReadEmployee = async (r) => (await fsFetch(r.token, "GET", "employees/A1B2C3D4")).code;

  test("the Devices menu is for the Super Admin only; HR is redirected away", async () => {
    const admin = await newPage();
    await adminLogin(admin, ACCOUNTS.admin);
    await admin.waitForSelector("#appShell:not(.hidden)");
    assert.equal(await hasHiddenClass(admin, "#devicesNavLink"), false);

    const hr = await newPage({ geolocation: null });
    await adminLogin(hr, ACCOUNTS.hr);
    await hr.waitForSelector("#appShell:not(.hidden)");
    assert.equal(await hasHiddenClass(hr, "#devicesNavLink"), true);
    await hr.goto(`${BASE}/#/devices`);
    await hr.waitForTimeout(500);
    assert.equal(await visible(hr, "#devicesView.is-active"), false);
    const res = await hr.evaluate(async () => {
      try { await firebase.firestore().collection("devices").get(); return "read"; } catch (e) { return e.code; }
    });
    assert.equal(res, "permission-denied", "HR must not be able to read the readers list");
  });

  test("a new reader appears live as Pending; Approve / Revoke / Remove work and really switch its access", async () => {
    const admin = await newPage();
    await adminLogin(admin, ACCOUNTS.admin);
    await admin.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await admin.goto(`${BASE}/#/devices`);
    await admin.waitForSelector("#devicesView.is-active");
    assert.match(await text(admin, "#devicesTableBody"), /No card readers yet/);

    const reader = await registerReader("Front Door");                      // chip powers on
    await admin.waitForFunction(() => document.querySelector("#devicesTableBody").textContent.includes("Front Door"));
    assert.match(await text(admin, "#devicesTableBody"), /Pending/);
    assert.equal(await readerCanReadEmployee(reader), 403, "pending reader must have no access");

    await admin.click("[data-approve-device]");                            // Super Admin clicks Approve
    await admin.waitForFunction(() => document.querySelector("#devicesTableBody").textContent.includes("Approved"));
    const env = await getEnv();
    let userDoc;
    await env.withSecurityRulesDisabled(async (ctx) => { userDoc = (await ctx.firestore().doc(`users/${reader.uid}`).get()).data(); });
    assert.equal(userDoc.role, "device");
    assert.equal(userDoc.name, "Front Door");
    assert.equal(userDoc.email, null);
    assert.equal(userDoc.createdBy, ACCOUNTS.admin.email);
    assert.equal(await readerCanReadEmployee(reader), 200, "approved reader can now look up employees");

    // it also shows up in the Users list as a Device
    await admin.goto(`${BASE}/#/users`);
    await admin.waitForFunction(() => document.querySelector("#usersTableBody").textContent.includes("Front Door"));
    assert.match(await text(admin, "#usersTableBody"), /Device/);

    await admin.goto(`${BASE}/#/devices`);
    await admin.click("[data-revoke-device]");                             // Revoke
    await admin.waitForFunction(() => document.querySelector("#devicesTableBody").textContent.includes("Pending"));
    assert.equal(await readerCanReadEmployee(reader), 403, "revoked reader is cut off");

    await admin.click("[data-remove-device]");                             // Remove
    await admin.waitForFunction(() => document.querySelector("#devicesTableBody").textContent.includes("No card readers yet"));
    let gone;
    await env.withSecurityRulesDisabled(async (ctx) => { gone = (await ctx.firestore().doc(`devices/${reader.uid}`).get()).exists; });
    assert.equal(gone, false);
  });

  test("a hostile reader name is shown as plain text and cannot run script in the Super Admin's session", async () => {
    await registerReader("<img src=x onerror=window.__xss=1>");
    const admin = await newPage();
    await adminLogin(admin, ACCOUNTS.admin);
    await admin.waitForSelector("#appShell:not(.hidden)");
    await admin.goto(`${BASE}/#/devices`);
    await admin.waitForFunction(() => document.querySelector("#devicesTableBody").textContent.includes("onerror"));
    assert.equal(await admin.evaluate(() => window.__xss || 0), 0, "reader name executed as HTML");
    assert.equal(await admin.locator("#devicesTableBody img").count(), 0);
  });

  test("exactly one sidebar item is highlighted on each page (Users vs Devices)", async () => {
    const admin = await newPage();
    await adminLogin(admin, ACCOUNTS.admin);
    await admin.waitForSelector("#appShell:not(.hidden)");
    for (const [route, view] of [["users", "usersView"], ["devices", "devicesView"], ["dashboard", "dashboardView"], ["devices", "devicesView"]]) {
      await admin.goto(`${BASE}/#/${route}`);
      await admin.waitForFunction((v) => document.querySelector(`.nav-link.is-active`)?.dataset.view === v, view);
      const active = await admin.locator(".nav-link.is-active").evaluateAll((els) => els.map((e) => e.dataset.view));
      assert.deepEqual(active, [view], `on #/${route}`);
    }
  });

  test("the Users form no longer offers a password-based 'device' role", async () => {
    const admin = await newPage();
    await adminLogin(admin, ACCOUNTS.admin);
    await admin.waitForSelector("#appShell:not(.hidden)");
    const roles = await admin.locator("#userRole option").evaluateAll((os) => os.map((o) => o.value));
    assert.deepEqual(roles.sort(), ["employee", "hr", "super_admin"]);
  });
});

describe("Settings", () => {
  test("super admin 'Load Sample Employees' button works", async () => {
    const page = await newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForSelector("#appShell:not(.hidden)");
    await page.goto(`${BASE}/#/settings`);
    await page.waitForSelector("#settingsView.is-active");
    await page.click("#sampleDataBtn");
    await page.waitForTimeout(500);
    assert.deepEqual(errors, [], `clicking Load Sample Employees threw: ${errors.join(" | ")}`);
    assert.match(await text(page, "#liveOutput"), /Sample employees loaded/);
  });
});

describe("pure helpers (evaluated in the real page)", () => {
  test("calcHours / calcMinutes / isLate / formatTimeAmPm / normalizeUid / escapeHtml", async () => {
    const page = await newPage();
    await page.goto(`${BASE}/`);
    const r = await page.evaluate(() => ({
      h1: calcHours("09:00:00", "17:30:00"),
      h2: calcHours("22:00:00", "02:15:00"),
      h3: calcMinutes("09:00:00", "09:00:00"),
      late1: isLate("09:15:00"),
      late2: isLate("09:16:00"),
      late3: isLate("09:15:59"),
      ampm: [formatTimeAmPm("00:05:00"), formatTimeAmPm("12:00:00"), formatTimeAmPm("13:07:00"), formatTimeAmPm("")],
      uid: normalizeUid(" a1-b2 c3:d4 "),
      esc: escapeHtml(`<img src=x onerror="a('b')">&`),
      month: [getMonthLabel("2026-01"), daysInMonth("2026-02"), daysInMonth("2028-02"), shiftMonth("2026-12", 1), shiftMonth("2026-01", -1)],
    }));
    assert.equal(r.h1, "8h 30m");
    assert.equal(r.h2, "4h 15m", "overnight shift wraps past midnight");
    assert.equal(r.h3, 0);
    assert.equal(r.late1, false, "exactly 09:15 is on time");
    assert.equal(r.late2, true);
    assert.equal(r.late3, false, "seconds are ignored");
    assert.deepEqual(r.ampm, ["12:05 AM", "12:00 PM", "1:07 PM", ""]);
    assert.equal(r.uid, "A1B2C3D4");
    assert.equal(r.esc, "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
    assert.deepEqual(r.month, ["Jan 2026", 28, 29, "2027-01", "2025-12"]);
  });

  test("shift timing: late / early leave / overtime against default, per-employee and per-day shifts", async () => {
    const page = await newPage();
    await page.goto(`${BASE}/`);
    const r = await page.evaluate(() => {
      state.employees = [
        { uid: "A", name: "A" },
        { uid: "B", name: "B", shiftStart: "10:00", shiftEnd: "19:00", shiftOverrides: { "2026-11-16": { start: "11:00", end: "20:00" } } },
      ];
      const t = (rec, shift) => {
        const x = shiftTiming(rec, shift);
        return [inRemark(x), outRemark(x)];
      };
      return {
        defA: getShiftFor("A", "2026-11-16"),
        defB: getShiftFor("B", "2026-11-15"),
        dayB: getShiftFor("B", "2026-11-16"),
        late10: t({ checkIn: "09:10:42", checkOut: "18:00:00" }, { start: "09:00", end: "18:00" }),
        early: t({ checkIn: "08:55:00", checkOut: "17:30:00" }, { start: "09:00", end: "18:00" }),
        overtime: t({ checkIn: "09:00:00", checkOut: "19:20:00" }, { start: "09:00", end: "18:00" }),
        longLate: t({ checkIn: "11:05:00" }, { start: "09:00", end: "18:00" }),
        night: t({ checkIn: "22:05:00", checkOut: "06:30:00" }, { start: "22:00", end: "06:00" }),
        sheet: buildSheetRows(["B"], "2026-11-16", "2026-11-16").map((row) => [row[6], row[7]]),
      };
    });
    assert.deepEqual(r.defA, { start: "09:00", end: "18:00", custom: false }, "no shift saved -> 9 to 6");
    assert.deepEqual(r.defB, { start: "10:00", end: "19:00", custom: false });
    assert.deepEqual(r.dayB, { start: "11:00", end: "20:00", custom: true }, "calendar override wins for that day");
    assert.deepEqual(r.late10, ["10 min late", "Full shift"], "9:10 for a 9:00 shift is 10 min late; seconds ignored");
    assert.deepEqual(r.early, ["On time", "Left 30 min early"]);
    assert.deepEqual(r.overtime, ["On time", "1h 20m overtime"]);
    assert.deepEqual(r.longLate, ["2h 5m late", ""]);
    assert.deepEqual(r.night, ["5 min late", "30 min overtime"], "overnight shift wraps past midnight");
    assert.deepEqual(r.sheet, [["11:00 AM - 8:00 PM", "Custom"]]);
  });
});

describe("XSS: stored employee data rendered as HTML", () => {
  const payload = `<img src=x onerror="window.__xss=(window.__xss||0)+1">`;
  test("a malicious employee name must not execute in the employee portal", async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc("employees/A1B2C3D4").set({
      uid: "A1B2C3D4", employeeId: "EMP001", name: payload, department: payload, role: payload, branch: payload, phone: payload,
    }));
    const page = await newPage();
    await employeeLogin(page, ACCOUNTS.emp);
    await page.waitForSelector("#empDashboard:not(.hidden)");
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__xss || 0), 0, "script from employee.name ran in the portal");
  });
  test("a malicious employee name must not execute in the staff dashboard", async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc("employees/A1B2C3D4").set({
      uid: "A1B2C3D4", employeeId: payload, name: payload, department: payload, role: payload, branch: payload, phone: payload,
    }));
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForSelector("#appShell:not(.hidden)");
    for (const route of ["dashboard", "employees/manager", "attendance", "attendance/today", "calendar"]) {
      await page.goto(`${BASE}/#/${route}`);
      await page.waitForTimeout(300);
    }
    assert.equal(await page.evaluate(() => window.__xss || 0), 0, "script from employee fields ran in the dashboard");
  });
});

describe("privilege escalation via stored XSS (HR -> Super Admin)", () => {
  test("script planted by an HR user in an employee record must not run in the Super Admin's session", async () => {
    const hr = await newPage({ geolocation: null });
    await adminLogin(hr, ACCOUNTS.hr);
    await hr.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await hr.goto(`${BASE}/#/employees`);
    await hr.waitForSelector("#employeeAddView.is-active");
    await hr.fill("#employeeUid", "XSS0001");
    await hr.fill("#employeeId", "EMP666");
    // Harmless proof: it only records whose session the script is running in.
    await hr.fill("#employeeName", `<img src=x onerror="window.__ranAs=firebase.auth().currentUser.email">`);
    await hr.fill("#employeeBranch", "b");
    await hr.fill("#employeeDepartment", "d");
    await hr.fill("#employeeRole", "r");
    await hr.click("#employeeForm button[type=submit]");
    await hr.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "4");

    const admin = await newPage();
    await adminLogin(admin, ACCOUNTS.admin);
    await admin.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "4");
    await admin.goto(`${BASE}/#/employees/manager`);
    await admin.waitForTimeout(500);
    const ranAs = await admin.evaluate(() => window.__ranAs || null);
    assert.equal(ranAs, null, `HR-planted script executed inside the Super Admin session (${ranAs})`);
  });
});

describe("regression: fixes for hostile / malformed stored data", () => {
  const xss = `<img src=x onerror="window.__xss=(window.__xss||0)+1">`;

  test("a remark containing HTML/script is shown as text, never executed (HR remark -> Super Admin drawer + calendar)", async () => {
    const hr = await newPage({ geolocation: null });
    await adminLogin(hr, ACCOUNTS.hr);
    await hr.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await hr.evaluate(() => openEmployeeDrawer("A1B2C3D4"));
    await hr.fill("#drawerRemarkInput", xss);
    await hr.click("#drawerAddRemarkBtn");
    await hr.waitForFunction(() => document.querySelector("#drawerRemarkList").textContent.includes("onerror"));

    const admin = await newPage();
    await adminLogin(admin, ACCOUNTS.admin);
    await admin.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await admin.evaluate(() => openEmployeeDrawer("A1B2C3D4"));
    await admin.waitForFunction(() => document.querySelector("#drawerRemarkList").textContent.includes("onerror"));
    await admin.goto(`${BASE}/#/calendar/${todayLocalKey()}`);
    await admin.waitForTimeout(500);
    assert.equal(await admin.evaluate(() => window.__xss || 0), 0, "remark HTML executed");
    assert.equal(await admin.locator("#drawerRemarkList img").count(), 0, "remark was rendered as markup");
  });

  test("malformed location data written by an employee cannot break or script the dashboard", async () => {
    const env = await getEnv();
    const day = todayLocalKey();
    await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`attendance/${day}_A1B2C3D4`).set({
      uid: "A1B2C3D4", dateKey: day, employeeName: "John Smith", checkIn: "09:00:00", checkOut: null,
      checkInLocation: { lat: `"><img src=x onerror="window.__xss=1">`, lng: "x" },
      checkOutLocation: "not-an-object",
    }));
    await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`attendance/${day}_E5F6G7H8`).set({
      uid: "E5F6G7H8", dateKey: day, employeeName: "Sarah Johnson", checkIn: "09:10:00", checkOut: null,
    }));
    const page = await newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForFunction(() => document.querySelector("#metricPresent").textContent === "2");
    await page.goto(`${BASE}/#/attendance/today`);
    await page.waitForFunction(() => document.querySelector("#todayAttendanceBody").textContent.includes("Sarah Johnson"));
    assert.match(await text(page, "#todayAttendanceBody"), /John Smith/, "the bad record must not stop the table rendering");
    assert.equal(await page.evaluate(() => window.__xss || 0), 0);
    assert.deepEqual(errors, []);
  });

  test("time strings with markup are rendered as text (calendar, tables)", async () => {
    const env = await getEnv();
    const day = todayLocalKey();
    await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`attendance/${day}_A1B2C3D4`).set({
      uid: "A1B2C3D4", dateKey: day, checkIn: `09:<img src=x onerror="window.__xss=(window.__xss||0)+1">`, checkOut: `17:<b>x</b>`,
    }));
    const page = await newPage();
    await adminLogin(page, ACCOUNTS.admin);
    await page.waitForFunction(() => document.querySelector("#metricCheckedOut").textContent === "1");
    for (const route of ["attendance/today", "attendance", `calendar/${day}`]) {
      await page.goto(`${BASE}/#/${route}`);
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => openEmployeeDrawer("A1B2C3D4"));
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__xss || 0), 0);
  });

  test("a scan the database rejects is reported as NOT saved: no phantom row, no stuck cooldown", async () => {
    const hr = await newPage({ geolocation: null });
    await adminLogin(hr, ACCOUNTS.hr);
    await hr.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    const env = await getEnv();
    await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`users/${uids.hr}`).delete()); // role revoked mid-session
    const outcome = await scan(hr, "A1B2C3D4");
    assert.equal(outcome, "ok", "processScan must handle the failure itself instead of throwing");
    const feed = await hr.evaluate(() => state.scanFeed.map((f) => `${f.type}:${f.message}`));
    assert.ok(feed.some((f) => /NOT saved/.test(f)), `scan feed: ${feed.join(" | ")}`);
    assert.ok(!feed.some((f) => /^CHECK_IN/.test(f)), "a failed scan must not be reported as a check-in");
    assert.equal(await hr.evaluate(() => state.attendance.length), 0, "no phantom attendance row");
    assert.equal((await readAttendance("A1B2C3D4")).length, 0);
    assert.equal(await hr.evaluate(() => scanCooldowns.size), 0, "cooldown must not block the retry");
  });

  test("editing an employee locks the card UID; 'Add Employee' in the menu starts a fresh unlocked form", async () => {
    const page = await newPage({ geolocation: null });
    await adminLogin(page, ACCOUNTS.hr);
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await page.evaluate(() => fillEmployeeForm("A1B2C3D4"));
    await page.waitForSelector("#employeeAddView.is-active");
    assert.equal(await page.locator("#employeeUid").evaluate((e) => e.readOnly), true);
    assert.equal(await page.locator("#employeeUid").inputValue(), "A1B2C3D4");
    // editing keeps the same doc: change the phone, save
    await page.fill("#employeeBranch", "Delhi HQ"); // seeded employee has no branch and the form requires one
    await page.fill("#employeePhone", "+91 1111111111");
    await page.click("#employeeForm button[type=submit]");
    await page.waitForFunction(() => document.querySelector("#employeeUid").readOnly === false);
    assert.equal((await readEmployee("A1B2C3D4")).phone, "+91 1111111111");
    assert.equal((await readEmployee("A1B2C3D4")).name, "John Smith", "edit must not lose other fields");
    // half-finished edit, then the menu's Add Employee
    await page.evaluate(() => fillEmployeeForm("E5F6G7H8"));
    await page.click('button[data-route="employees/add"]');
    assert.equal(await page.locator("#employeeUid").evaluate((e) => e.readOnly), false);
    assert.equal(await page.locator("#employeeUid").inputValue(), "");
  });

  test("Employee ID uniqueness is case-insensitive and editing your own record is still allowed", async () => {
    const page = await newPage({ geolocation: null });
    await adminLogin(page, ACCOUNTS.hr);
    await page.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await addEmployeeViaForm(page, { uid: "CAFE0009", id: "emp001", name: "Lowercase Dup" });
    await page.waitForTimeout(600);
    assert.equal(await readEmployee("CAFE0009"), undefined);
  });
});

describe("visual smoke (screenshots to $SHOTS_DIR when set)", () => {
  const dir = process.env.SHOTS_DIR;
  test("each role's main screen renders", { skip: !dir }, async () => {
    const shot = (page, name) => page.screenshot({ path: path.join(dir, `${name}.png`) });
    const a = await newPage();
    await adminLogin(a, ACCOUNTS.admin);
    await a.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await scan(a, "A1B2C3D4");
    await a.waitForTimeout(500);
    await a.evaluate(() => closeEmployeeDrawer());
    await a.goto(`${BASE}/#/attendance/today`); await a.waitForTimeout(400); await shot(a, "1-admin-attendance-today");
    await a.goto(`${BASE}/#/users`); await a.waitForTimeout(400); await shot(a, "2-admin-users");
    // two card readers: one already approved, one still pending
    const env = await getEnv();
    for (const [name, approved] of [["Main Gate", true], ["Back Door", false]]) {
      const j = JSON.parse((await anonymousSignUp()).text);
      const body = JSON.stringify({ fields: { name: { stringValue: name }, requestedAt: { stringValue: new Date().toISOString() }, lastSeenAt: { stringValue: new Date().toISOString() } } });
      await fsFetch(j.idToken, "PATCH", `devices/${j.localId}`, { body, query: "?currentDocument.exists=false" });
      if (approved) await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`users/${j.localId}`).set({ email: null, name, role: "device", employeeUid: null }));
    }
    await a.goto(`${BASE}/#/devices`);
    await a.waitForFunction(() => document.querySelectorAll("#devicesTableBody tr").length === 2 && document.querySelector("#devicesTableBody").textContent.includes("Approved"));
    await shot(a, "5-admin-devices");
    const h = await newPage();
    await adminLogin(h, ACCOUNTS.hr);
    await h.waitForFunction(() => document.querySelector("#metricEmployees").textContent === "3");
    await h.goto(`${BASE}/#/employees/manager`); await h.waitForTimeout(400); await shot(h, "3-hr-employees");
    const e = await newPage();
    await employeeLogin(e, ACCOUNTS.emp);
    await e.waitForSelector("#empDashboard:not(.hidden)"); await e.waitForTimeout(600); await shot(e, "4-employee-portal");
  });
});

after(() => {
  if (pageErrors.length) console.log(`\n[uncaught page errors seen during e2e: ${pageErrors.length}]\n` + [...new Set(pageErrors)].join("\n"));
});
