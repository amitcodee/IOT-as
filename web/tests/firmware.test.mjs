// Replays what the ESP32 firmware does (hardware/rfid_wifi/rfid_wifi.ino) against the Firebase
// emulators + the real firestore.rules. The JS below is a line-for-line port of the sketch's logic
// (the sketch itself can't be compiled here) - keep the two in step.
import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getEnv, closeEnv, resetAndSeed, reseedFirestore, signIn, ACCOUNTS, fsFetch, anonymousSignUp, refreshTokenExchange,
} from "./helpers.mjs";

const JOHN = "A1B2C3D4";
const DATE = "2026-09-21";

// --- port of rfid_wifi.ino processScan() --------------------------------------------------
async function firmwareTap(token, uid, { dateKey = DATE, timeStr }) {
  // 404 = unknown card; 403 = this reader is not approved (or was revoked); anything else = lookup error.
  const emp = await fsFetch(token, "GET", `employees/${uid}`);
  if (emp.code === 404) {
    const body = JSON.stringify({
      fields: {
        uid: { stringValue: uid },
        lastScanAt: { stringValue: `${dateKey}T${timeStr}` },
        readerId: { stringValue: "reader" },
        readerName: { stringValue: "Front Door" },
      },
    });
    const w = await fsFetch(token, "PATCH", `unknownCards/${uid}`, { body });
    return { result: "UNKNOWN CARD", code: emp.code, reported: w.code === 200 };
  }
  if (emp.code === 403) return { result: "NOT APPROVED", code: emp.code };
  if (emp.code !== 200) return { result: "Employee lookup failed", code: emp.code };

  // Ask for ONLY checkOut so the reply is unambiguous.
  const docId = `${dateKey}_${uid}`;
  const att = await fsFetch(token, "GET", `attendance/${docId}`, { query: "?mask.fieldPaths=checkOut" });
  // Never write on a failed read.
  if (att.code !== 200 && att.code !== 404) return { result: "Attendance lookup failed", code: att.code };

  if (att.code === 404) {
    const body = JSON.stringify({
      fields: {
        uid: { stringValue: uid },
        dateKey: { stringValue: dateKey },
        checkIn: { stringValue: timeStr },
        checkOut: { nullValue: null },
      },
    });
    // create only, never overwrite
    const w = await fsFetch(token, "PATCH", `attendance/${docId}`, { body, query: "?currentDocument.exists=false" });
    return { result: w.code === 200 ? "CHECK IN" : "Write failed", code: w.code };
  }

  const hasCheckOut = att.text.indexOf('"stringValue"') >= 0;
  if (!hasCheckOut) {
    const body = JSON.stringify({ fields: { checkOut: { stringValue: timeStr } } });
    const w = await fsFetch(token, "PATCH", `attendance/${docId}`, {
      body,
      query: "?updateMask.fieldPaths=checkOut&currentDocument.exists=true",
    });
    return { result: w.code === 200 ? "CHECK OUT" : "Update failed", code: w.code };
  }
  return { result: "ALREADY DONE" };
}

// --- port of the sign-in block (jsonStr / registerAnonymous / refreshIdToken / announceDevice /
//     heartbeat / ensureSession) ----------------------------------------------------------
function jsonStr(json, key) {
  const k = json.indexOf(`"${key}"`);
  if (k < 0) return "";
  const colon = json.indexOf(":", k);
  if (colon < 0) return "";
  const q1 = json.indexOf('"', colon + 1);
  if (q1 < 0) return "";
  const q2 = json.indexOf('"', q1 + 1);
  if (q2 < 0) return "";
  return json.substring(q1 + 1, q2);
}
const isoNow = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

class Reader {
  constructor(name = "Main Gate") {
    this.name = name;
    this.flash = { refresh: "", uid: "" }; // survives reboots (Preferences)
    this.idToken = "";                     // RAM only
    this.expired = false;                  // stands in for "TOKEN_REFRESH_MS has passed"
    this.log = [];
  }
  reboot() { this.idToken = ""; this.expired = false; }
  get uid() { return this.flash.uid; }

  async registerAnonymous() {
    const r = await anonymousSignUp();
    if (r.code !== 200) return false;
    const token = jsonStr(r.text, "idToken");
    const refresh = jsonStr(r.text, "refreshToken");
    const uid = jsonStr(r.text, "localId");
    if (token.length < 100 || !refresh || !uid) return false;
    this.idToken = token;
    this.flash = { refresh, uid };
    this.expired = false;
    return true;
  }
  async refreshIdToken() { // 1 ok, 0 try later, -1 saved sign-in no longer valid
    const r = await refreshTokenExchange(this.flash.refresh);
    if (r.code === 200) {
      const token = jsonStr(r.text, "id_token");
      const refresh = jsonStr(r.text, "refresh_token");
      if (token.length < 100) return 0;
      this.idToken = token;
      this.expired = false;
      if (refresh && refresh !== this.flash.refresh) this.flash.refresh = refresh;
      return 1;
    }
    if (r.code === 400 || r.code === 401) return -1;
    return 0;
  }
  async announce() {
    const body = JSON.stringify({ fields: { name: { stringValue: this.name }, requestedAt: { stringValue: isoNow() } } });
    return fsFetch(this.idToken, "PATCH", `devices/${this.uid}`, { body, query: "?currentDocument.exists=false" });
  }
  async heartbeat() {
    const body = JSON.stringify({ fields: { lastSeenAt: { stringValue: isoNow() } } });
    const w = await fsFetch(this.idToken, "PATCH", `devices/${this.uid}`, { body, query: "?updateMask.fieldPaths=lastSeenAt&currentDocument.exists=true" });
    if (w.code !== 200) await this.announce();
  }
  async ensureSession() {
    if (!this.flash.refresh) {
      if (!(await this.registerAnonymous())) return false;
      await this.announce();
      this.log.push("registered");
      return true;
    }
    if (!this.idToken || this.expired) {
      const r = await this.refreshIdToken();
      if (r === -1) {
        this.flash = { refresh: "", uid: "" };
        this.idToken = "";
        this.log.push("re-registering");
        return this.ensureSession();
      }
      if (r === 1) await this.heartbeat();
      if (r === 0 && !this.idToken) return false;
    }
    return !!this.idToken;
  }
  async tap(uid, timeStr) {
    if (!(await this.ensureSession())) return { result: "No token" };
    return firmwareTap(this.idToken, uid, { timeStr });
  }
}
// -----------------------------------------------------------------------------------------

let env;
let uids;
const tokens = {};
before(async () => {
  env = await getEnv();
  ({ uids } = await resetAndSeed());
  for (const k of ["admin", "hr", "device", "emp", "emp2"]) {
    tokens[k] = (await signIn(ACCOUNTS[k].email, ACCOUNTS[k].password)).idToken;
  }
});
beforeEach(() => reseedFirestore(uids));
after(closeEnv);

async function readAtt() {
  let out;
  await env.withSecurityRulesDisabled(async (ctx) => {
    out = (await ctx.firestore().doc(`attendance/${DATE}_${JOHN}`).get()).data();
  });
  return out;
}
const readDoc = async (path) => {
  let out;
  await env.withSecurityRulesDisabled(async (ctx) => { out = (await ctx.firestore().doc(path).get()).data(); });
  return out;
};
const seedAtt = (data) => env.withSecurityRulesDisabled((ctx) =>
  ctx.firestore().doc(`attendance/${DATE}_${JOHN}`).set({ uid: JOHN, dateKey: DATE, ...data }));

// What the web dashboard's "Approve" / "Revoke" buttons do, through the real rules as the Super Admin.
const adminDb = () => env.authenticatedContext(uids.admin).firestore();
const approve = (uid, name = "Main Gate") => adminDb().doc(`users/${uid}`).set({
  email: null, name, role: "device", employeeUid: null, createdAt: new Date().toISOString(), createdBy: "admin@test.local",
});
const revoke = (uid) => adminDb().doc(`users/${uid}`).delete();

describe("firmware full day: tap in -> tap out -> tap again", () => {
  for (const role of ["device", "hr", "admin"]) {
    test(`signed in as '${role}': check-in, check-out, then ALREADY DONE`, async () => {
      const t = tokens[role];
      const r1 = await firmwareTap(t, JOHN, { timeStr: "09:00:00" });
      assert.equal(r1.result, "CHECK IN", `tap 1: ${JSON.stringify(r1)}`);

      const r2 = await firmwareTap(t, JOHN, { timeStr: "17:30:00" });
      assert.equal(r2.result, "CHECK OUT", `tap 2: ${JSON.stringify(r2)}`);
      const doc = await readAtt();
      assert.equal(doc.checkIn, "09:00:00", "check-in must be preserved");
      assert.equal(doc.checkOut, "17:30:00");

      const r3 = await firmwareTap(t, JOHN, { timeStr: "18:00:00" });
      assert.equal(r3.result, "ALREADY DONE", `tap 3: ${JSON.stringify(r3)}`);
      assert.equal((await readAtt()).checkOut, "17:30:00", "third tap must not overwrite the recorded check-out");
    });
  }

  test("unknown card (404): no attendance written, card reported to the dashboard as unassigned", async () => {
    const r = await firmwareTap(tokens.device, "DEADBEEF", { timeStr: "09:00:00" });
    assert.equal(r.result, "UNKNOWN CARD");
    assert.equal(r.reported, true, "approved reader may record the unknown card");
    assert.equal(await readAtt(), undefined);
  });
});

describe("card reader pairing: NO email/password on the chip", () => {
  test("first boot: signs in anonymously, announces itself as Pending, and is refused until approved", async () => {
    const reader = new Reader("Front Door");
    assert.equal(await reader.ensureSession(), true);
    assert.ok(reader.uid, "got an anonymous uid");
    assert.deepEqual(reader.log, ["registered"]);

    const dev = await readDoc(`devices/${reader.uid}`);
    assert.equal(dev.name, "Front Door");
    assert.match(dev.requestedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(await readDoc(`users/${reader.uid}`), undefined, "pending: no role doc");

    const r = await reader.tap(JOHN, "09:00:00");
    assert.equal(r.result, "NOT APPROVED", JSON.stringify(r));
    assert.equal(await readAtt(), undefined, "a pending reader must not write attendance");
  });

  test("after the Super Admin approves it in the web, the SAME reader records a full day", async () => {
    const reader = new Reader();
    await reader.ensureSession();
    assert.equal((await reader.tap(JOHN, "09:00:00")).result, "NOT APPROVED");

    await approve(reader.uid); // clicking Approve in the Devices panel
    assert.equal((await reader.tap(JOHN, "09:01:00")).result, "CHECK IN");
    assert.equal((await reader.tap(JOHN, "17:30:00")).result, "CHECK OUT");
    assert.equal((await reader.tap(JOHN, "18:00:00")).result, "ALREADY DONE");
    const doc = await readAtt();
    assert.equal(doc.checkIn, "09:01:00");
    assert.equal(doc.checkOut, "17:30:00");
  });

  test("reboot: the saved refresh token gives the same identity back, with no password", async () => {
    const reader = new Reader();
    await reader.ensureSession();
    await approve(reader.uid);
    const uidBefore = reader.uid;

    reader.reboot();                           // RAM cleared, flash kept
    assert.equal(await reader.ensureSession(), true);
    assert.equal(reader.uid, uidBefore, "same reader identity after reboot");
    assert.ok(!reader.log.includes("re-registering"));
    assert.equal((await reader.tap(JOHN, "09:00:00")).result, "CHECK IN", "still approved after reboot");
  });

  test("hourly token refresh keeps working and updates 'last seen'", async () => {
    const reader = new Reader();
    await reader.ensureSession();
    await approve(reader.uid);
    assert.equal((await readDoc(`devices/${reader.uid}`)).lastSeenAt, undefined);

    reader.expired = true;                     // ~45 minutes later
    assert.equal(await reader.ensureSession(), true);
    const seen = (await readDoc(`devices/${reader.uid}`)).lastSeenAt;
    assert.match(seen, /^\d{4}-\d\d-\d\dT/, "heartbeat written");
    assert.equal((await reader.tap(JOHN, "09:00:00")).result, "CHECK IN");
  });

  test("revoking in the web stops the reader immediately; approving again restores it", async () => {
    const reader = new Reader();
    await reader.ensureSession();
    await approve(reader.uid);
    assert.equal((await reader.tap(JOHN, "09:00:00")).result, "CHECK IN");

    await revoke(reader.uid);                  // Revoke button
    assert.equal((await reader.tap(JOHN, "17:00:00")).result, "NOT APPROVED");
    assert.equal((await readAtt()).checkOut, null, "revoked reader must not record");

    await approve(reader.uid);
    assert.equal((await reader.tap(JOHN, "17:05:00")).result, "CHECK OUT");
  });

  test("if the saved sign-in is invalid (e.g. user deleted), the reader registers again as a NEW pending reader", async () => {
    const reader = new Reader();
    await reader.ensureSession();
    const oldUid = reader.uid;
    reader.flash.refresh = "not-a-real-refresh-token";
    reader.reboot();
    assert.equal(await reader.ensureSession(), true);
    assert.ok(reader.log.includes("re-registering"));
    assert.notEqual(reader.uid, oldUid, "a fresh identity");
    assert.ok(await readDoc(`devices/${reader.uid}`), "announced again");
    assert.equal((await reader.tap(JOHN, "09:00:00")).result, "NOT APPROVED");
  });

  test("announce is create-only: an admin's rename survives a reboot; a removed entry is re-announced", async () => {
    const reader = new Reader("Main Gate");
    await reader.ensureSession();
    await adminDb().doc(`devices/${reader.uid}`).update({ name: "Renamed by admin" });
    await reader.announce();                                  // e.g. a second announce
    assert.equal((await readDoc(`devices/${reader.uid}`)).name, "Renamed by admin");

    reader.expired = true;
    await reader.ensureSession();                             // heartbeat keeps the entry, name intact
    assert.equal((await readDoc(`devices/${reader.uid}`)).name, "Renamed by admin");

    await adminDb().doc(`devices/${reader.uid}`).delete();    // admin clicked Remove
    assert.equal(await readDoc(`devices/${reader.uid}`), undefined);
    reader.expired = true;
    await reader.ensureSession();                             // next heartbeat re-announces it
    assert.ok(await readDoc(`devices/${reader.uid}`), "removed reader shows up as Pending again");
  });

  test("a pending reader cannot approve itself or touch anything else, even by calling the REST API directly", async () => {
    const reader = new Reader();
    await reader.ensureSession();
    const self = await fsFetch(reader.idToken, "PATCH", `users/${reader.uid}`, {
      body: JSON.stringify({ fields: { role: { stringValue: "super_admin" }, name: { stringValue: "x" } } }),
    });
    assert.equal(self.code, 403);
    for (const path of ["employees", "attendance", "users", "devices", "remarks"]) {
      assert.equal((await fsFetch(reader.idToken, "GET", path)).code, 403, `list ${path}`);
    }
  });

  test("jsonStr parses Google's pretty-printed replies as well as the emulator's compact ones", () => {
    const compact = '{"kind":"x","idToken":"AAA.BBB.CCC","refreshToken":"R-1_x","localId":"uid1"}';
    const pretty = '{\n  "kind": "identitytoolkit#SignupNewUserResponse",\n  "idToken": "AAA.BBB.CCC",\n  "refreshToken": "R-1_x",\n  "expiresIn": "3600",\n  "localId": "uid1"\n}';
    for (const j of [compact, pretty]) {
      assert.equal(jsonStr(j, "idToken"), "AAA.BBB.CCC");
      assert.equal(jsonStr(j, "refreshToken"), "R-1_x");
      assert.equal(jsonStr(j, "localId"), "uid1");
    }
    assert.equal(jsonStr(compact, "nope"), "");
    assert.equal(jsonStr(pretty, "id_token"), "", "snake_case key is a different key");
    const refresh = '{\n  "access_token": "T1",\n  "expires_in": "3600",\n  "token_type": "Bearer",\n  "refresh_token": "R2",\n  "id_token": "T1",\n  "user_id": "u"\n}';
    assert.equal(jsonStr(refresh, "id_token"), "T1");
    assert.equal(jsonStr(refresh, "refresh_token"), "R2");
  });
});

describe("firmware error handling", () => {
  test("a permission error (403) is reported as NOT APPROVED, never as an unknown card", async () => {
    // Sarah's employee login may not read John's employee doc -> 403
    const r = await firmwareTap(tokens.emp2, JOHN, { timeStr: "09:00:00" });
    assert.equal(r.result, "NOT APPROVED");
    assert.equal(r.code, 403);
  });

  test("check-in is create-only: it can never overwrite an existing record", async () => {
    await seedAtt({ checkIn: "09:00:00", checkOut: "17:00:00", employeeName: "John Smith" });
    const body = JSON.stringify({
      fields: { uid: { stringValue: JOHN }, dateKey: { stringValue: DATE }, checkIn: { stringValue: "23:00:00" }, checkOut: { nullValue: null } },
    });
    const w = await fsFetch(tokens.admin, "PATCH", `attendance/${DATE}_${JOHN}`, { body, query: "?currentDocument.exists=false" });
    assert.notEqual(w.code, 200, "create-only PATCH must fail when the record already exists");
    const doc = await readAtt();
    assert.equal(doc.checkIn, "09:00:00");
    assert.equal(doc.checkOut, "17:00:00");
    assert.equal(doc.employeeName, "John Smith", "other fields must survive");
  });

  test("check-out never recreates a record the employee just deleted", async () => {
    const body = JSON.stringify({ fields: { checkOut: { stringValue: "17:00:00" } } });
    const w = await fsFetch(tokens.hr, "PATCH", `attendance/${DATE}_${JOHN}`, { body, query: "?updateMask.fieldPaths=checkOut&currentDocument.exists=true" });
    assert.notEqual(w.code, 200);
    assert.equal(await readAtt(), undefined, "a bare check-out-only record must not be created");
  });

  test("the device role can read ONE attendance doc but cannot list the collection", async () => {
    await seedAtt({ checkIn: "09:00:00", checkOut: null });
    const one = await fsFetch(tokens.device, "GET", `attendance/${DATE}_${JOHN}`);
    assert.equal(one.code, 200);
    const list = await fsFetch(tokens.device, "GET", "attendance");
    assert.equal(list.code, 403, "device must not be able to list all attendance");
  });
});

describe("firmware vs data written by the web dashboard / employee portal", () => {
  // The dashboard's saveAttendance() writes checkInLocation / checkOutLocation as explicit null when no
  // geolocation was available, so REST returns {"nullValue": null} for them.
  for (const role of ["device", "hr", "admin"]) {
    test(`${role}: check-out already recorded but checkOutLocation is null -> ALREADY DONE, time untouched`, async () => {
      await seedAtt({ employeeId: "EMP001", employeeName: "John Smith", checkIn: "09:00:00", checkOut: "17:00:00", checkInLocation: null, checkOutLocation: null });
      const r = await firmwareTap(tokens[role], JOHN, { timeStr: "23:59:59" });
      assert.equal(r.result, "ALREADY DONE", JSON.stringify(r));
      assert.equal((await readAtt()).checkOut, "17:00:00", "an extra tap rewrote the recorded check-out time");
    });
  }

  test("employee deletes their check-out in the portal -> next card tap checks them out again", async () => {
    for (const role of ["device", "hr"]) {
      await seedAtt({ checkIn: "09:00:00", checkOut: "17:00:00" });
      // portal: docRef.update({checkOut: FieldValue.delete()}) - the key disappears entirely
      const del = await fsFetch(tokens.emp, "PATCH", `attendance/${DATE}_${JOHN}`, {
        body: JSON.stringify({ fields: {} }),
        query: "?updateMask.fieldPaths=checkOut&currentDocument.exists=true",
      });
      assert.equal(del.code, 200, `employee undo failed: ${del.text}`);
      assert.equal((await readAtt()).checkOut, undefined, "checkOut key removed");

      const r = await firmwareTap(tokens[role], JOHN, { timeStr: "17:45:00" });
      assert.equal(r.result, "CHECK OUT", `${role}: ${JSON.stringify(r)}`);
      assert.equal((await readAtt()).checkOut, "17:45:00");
    }
  });
});

describe("firmware settings file", () => {
  const ino = readFileSync(new URL("../../hardware/rfid_wifi/rfid_wifi.ino", import.meta.url), "utf8");
  const example = readFileSync(new URL("../../hardware/rfid_wifi/secrets.h.example", import.meta.url), "utf8");

  test("the sketch has NO Firebase email/password and no secrets of its own", () => {
    assert.match(ino, /#include\s+"secrets\.h"/);
    assert.doesNotMatch(ino, /MY_AUTH_/, "an email/password setting is still referenced");
    assert.doesNotMatch(ino, /signInWithPassword/, "the sketch must not sign in with an email + password");
    assert.doesNotMatch(ino, /#define\s+MY_(WIFI_PASS|WIFI_SSID|API_KEY|PROJECT_ID)\b/, "settings must not be #define'd in the sketch");
    assert.doesNotMatch(ino, /AIza[0-9A-Za-z_-]{20,}/, "a Firebase API key is hard-coded in the sketch");
  });

  test("it signs in anonymously and keeps the refresh token in flash (Preferences), not in source", () => {
    assert.match(ino, /accounts:signUp/);
    assert.match(ino, /securetoken\.googleapis\.com/);
    assert.match(ino, /#include\s+<Preferences\.h>/);
    assert.match(ino, /prefs\.putString\("refresh"/);
  });

  test("secrets.h.example defines every MY_* the sketch uses - WiFi, project, reader name, timezone only", () => {
    const used = [...new Set([...ino.matchAll(/\bMY_[A-Z_]+\b/g)].map((m) => m[0]))].sort();
    assert.deepEqual(used, ["MY_API_KEY", "MY_DEVICE_NAME", "MY_GMT_OFFSET", "MY_PROJECT_ID", "MY_WIFI_PASS", "MY_WIFI_SSID"]);
    for (const sym of used) assert.match(example, new RegExp(`#define\\s+${sym}\\b`), `secrets.h.example is missing ${sym}`);
    assert.doesNotMatch(example, /MY_AUTH_/, "the template must not ask for an email/password");
    assert.match(example, /MY_WIFI_PASS\s+"YOUR_/);
    assert.doesNotMatch(example, /AIza[0-9A-Za-z_-]{20,}/);
    const name = /#define\s+MY_DEVICE_NAME\s+"([^"]*)"/.exec(example)[1];
    assert.ok(name.length > 0 && name.length <= 40, "MY_DEVICE_NAME must be 1-40 characters (the database rule)");
  });
});
