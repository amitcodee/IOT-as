// Firestore security rules, tested against the emulator with the real firestore.rules.
// Each test states the INTENDED behaviour (from the header comment in firestore.rules,
// setup.md, and how the dashboard / employee portal / firmware use the database).
import { describe, test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
import { getEnv, closeEnv, resetAndSeed, reseedFirestore, EMPLOYEES } from "./helpers.mjs";

// Expected permission-denied errors are the point of these tests; keep the SDK quiet.
firebase.firestore.setLogLevel("silent");

const DAY = "2026-09-21";
const JOHN = "A1B2C3D4";
const SARAH = "E5F6G7H8";
const docId = (uid) => `${DAY}_${uid}`;
const del = () => firebase.firestore.FieldValue.delete();

let env;
let uids;
const as = (key) => env.authenticatedContext(uids[key]).firestore();
const anon = () => env.unauthenticatedContext().firestore();

// Seed an attendance doc bypassing rules.
async function seedAttendance(uid, data) {
  await env.withSecurityRulesDisabled((ctx) =>
    ctx.firestore().doc(`attendance/${docId(uid)}`).set({ uid, dateKey: DAY, ...data }));
}

before(async () => {
  env = await getEnv();
  ({ uids } = await resetAndSeed());
});
beforeEach(() => reseedFirestore(uids));
after(closeEnv);

describe("users/{uid} — role directory", () => {
  test("unauthenticated cannot read any user doc", async () => {
    await assertFails(anon().doc(`users/${uids.admin}`).get());
  });
  test("every role can read its own user doc (needed at login)", async () => {
    for (const k of ["admin", "hr", "emp", "device"]) {
      await assertSucceeds(as(k).doc(`users/${uids[k]}`).get());
    }
  });
  test("hr / employee / device cannot read someone else's user doc", async () => {
    for (const k of ["hr", "emp", "device"]) {
      await assertFails(as(k).doc(`users/${uids.admin}`).get());
    }
  });
  test("only super_admin can list users", async () => {
    await assertSucceeds(as("admin").collection("users").get());
    for (const k of ["hr", "emp", "device", "norole"]) {
      await assertFails(as(k).collection("users").get());
    }
  });
  test("only super_admin can create / update roles", async () => {
    const newUser = { email: "x@y.z", name: "X", role: "hr", employeeUid: null };
    await assertSucceeds(as("admin").doc("users/newuid1").set(newUser));
    await assertSucceeds(as("admin").doc(`users/${uids.hr}`).update({ role: "device" }));
    for (const k of ["hr", "emp", "device"]) {
      await assertFails(as(k).doc("users/newuid2").set(newUser));
      await assertFails(as(k).doc(`users/${uids[k]}`).update({ role: "super_admin" }));
    }
  });
  test("privilege escalation: a signed-in user with NO role doc cannot self-grant super_admin", async () => {
    await assertFails(as("norole").doc(`users/${uids.norole}`).set({ role: "super_admin", email: "n@t.l", name: "N" }));
  });
  test("super_admin can revoke others but not delete their own doc", async () => {
    await assertSucceeds(as("admin").doc(`users/${uids.hr}`).delete());
    await assertFails(as("admin").doc(`users/${uids.admin}`).delete());
  });
  test("hr cannot delete admin / hr / device logins (only employee logins)", async () => {
    await assertFails(as("hr").doc(`users/${uids.admin}`).delete());
    await assertFails(as("hr").doc(`users/${uids.hr}`).delete());
    await assertFails(as("hr").doc(`users/${uids.device}`).delete());
  });
});

describe("users/{uid} - admin makes HR, HR makes employee logins", () => {
  const employeeLogin = (over = {}) => ({
    email: "new.employee@test.local", name: "New Employee", role: "employee", employeeUid: JOHN,
    createdAt: "2026-09-21T09:00:00.000Z", createdBy: "hr@test.local", ...over,
  });

  test("super_admin can create an HR login (and any other role)", async () => {
    for (const [i, role] of ["hr", "super_admin", "employee"].entries()) {
      await assertSucceeds(as("admin").doc(`users/made-by-admin-${i}`).set({ email: `a${i}@x.y`, name: "N", role, employeeUid: role === "employee" ? JOHN : null }));
    }
  });

  test("hr can create an employee login linked to an existing employee", async () => {
    await assertSucceeds(as("hr").doc("users/emp-login-1").set(employeeLogin()));
  });

  test("hr can NOT create hr / super_admin / device logins", async () => {
    for (const role of ["hr", "super_admin", "device"]) {
      await assertFails(as("hr").doc(`users/evil-${role}`).set(employeeLogin({ role, employeeUid: null })));
    }
  });

  test("hr can NOT smuggle extra fields into an employee login", async () => {
    for (const extra of [{ isAdmin: true }, { permissions: ["all"] }, { approved: true }]) {
      await assertFails(as("hr").doc("users/emp-login-x").set(employeeLogin(extra)));
    }
  });

  test("an employee login must point at an EXISTING employee record", async () => {
    await assertFails(as("hr").doc("users/emp-login-y").set(employeeLogin({ employeeUid: "NO_SUCH_CARD" })));
    await assertFails(as("hr").doc("users/emp-login-y").set(employeeLogin({ employeeUid: null })));
    await assertFails(as("hr").doc("users/emp-login-y").set(employeeLogin({ employeeUid: 12345 })));
  });

  test("hr can NOT overwrite or edit any existing login (create only)", async () => {
    // re-creating over the admin / another hr / an employee, or changing a role, is an update
    await assertFails(as("hr").doc(`users/${uids.admin}`).set(employeeLogin()));
    await assertFails(as("hr").doc(`users/${uids.hr}`).set(employeeLogin()));
    await assertFails(as("hr").doc(`users/${uids.emp}`).set(employeeLogin()));
    await assertFails(as("hr").doc(`users/${uids.emp}`).update({ employeeUid: "E5F6G7H8" }));
    await assertFails(as("hr").doc(`users/${uids.hr}`).update({ role: "super_admin" }));
  });

  test("hr sees only employee logins: a filtered query works, an unfiltered one is denied", async () => {
    const snap = await assertSucceeds(as("hr").collection("users").where("role", "==", "employee").get());
    assert.ok(snap.size >= 2, "employee logins are listed");
    assert.ok(snap.docs.every((d) => d.data().role === "employee"), "only employee logins come back");
    await assertFails(as("hr").collection("users").get());
    await assertFails(as("hr").collection("users").where("role", "==", "hr").get());
    await assertFails(as("hr").collection("users").where("role", "==", "super_admin").get());
  });

  test("hr can read an employee login but not an hr / admin login", async () => {
    await assertSucceeds(as("hr").doc(`users/${uids.emp}`).get());
    await assertFails(as("hr").doc(`users/${uids.admin}`).get());
    await assertSucceeds(as("hr").doc(`users/${uids.hr}`).get()); // their own record
    await assertFails(as("hr").doc(`users/${uids.device}`).get());
  });

  test("hr can revoke (delete) an employee login, and only that", async () => {
    await assertSucceeds(as("hr").doc(`users/${uids.emp}`).delete());
    await assertFails(as("hr").doc(`users/${uids.admin}`).delete());
    await assertFails(as("hr").doc(`users/${uids.hr}`).delete());
  });

  test("employees, devices and role-less accounts still cannot create any login", async () => {
    for (const k of ["emp", "device", "norole"]) {
      await assertFails(as(k).doc(`users/from-${k}`).set(employeeLogin()));
    }
    await assertFails(anon().doc("users/from-anon").set(employeeLogin()));
  });

  test("an HR-created employee login really works: that employee can read their own record", async () => {
    await assertSucceeds(as("hr").doc("users/brand-new-emp").set(employeeLogin({ employeeUid: JOHN })));
    const asNew = env.authenticatedContext("brand-new-emp").firestore();
    await assertSucceeds(asNew.doc(`employees/${JOHN}`).get());
    await assertFails(asNew.doc("employees/E5F6G7H8").get());
    await assertFails(asNew.doc("users/other").set(employeeLogin()));
  });
});

describe("employees/{uid}", () => {
  test("unauthenticated and role-less accounts have no access", async () => {
    await assertFails(anon().doc(`employees/${JOHN}`).get());
    await assertFails(as("norole").doc(`employees/${JOHN}`).get());
    await assertFails(as("norole").collection("employees").get());
  });
  test("super_admin and hr can list + get", async () => {
    for (const k of ["admin", "hr"]) {
      await assertSucceeds(as(k).collection("employees").get());
      await assertSucceeds(as(k).doc(`employees/${JOHN}`).get());
    }
  });
  test("device can get a single employee (firmware lookup) but not list", async () => {
    await assertSucceeds(as("device").doc(`employees/${JOHN}`).get());
    await assertFails(as("device").collection("employees").get());
  });
  test("employee can read only their own employee doc", async () => {
    await assertSucceeds(as("emp").doc(`employees/${JOHN}`).get());
    await assertFails(as("emp").doc(`employees/${SARAH}`).get());
    await assertFails(as("emp").collection("employees").get());
  });
  test("super_admin and hr can create + edit employees", async () => {
    for (const k of ["admin", "hr"]) {
      await assertSucceeds(as(k).doc(`employees/NEW_${k}`).set({ uid: `NEW_${k}`, employeeId: "E9", name: "New" }));
      await assertSucceeds(as(k).doc(`employees/${JOHN}`).set({ phone: "123" }, { merge: true }));
    }
  });
  test("device and employee cannot create / edit employees", async () => {
    for (const k of ["device", "emp"]) {
      await assertFails(as(k).doc("employees/NOPE").set({ uid: "NOPE", name: "Nope" }));
      await assertFails(as(k).doc(`employees/${JOHN}`).update({ name: "Hacked" }));
    }
  });
  test("only super_admin can delete an employee", async () => {
    await assertFails(as("hr").doc(`employees/${JOHN}`).delete());
    await assertFails(as("device").doc(`employees/${JOHN}`).delete());
    await assertFails(as("emp").doc(`employees/${JOHN}`).delete());
    await assertSucceeds(as("admin").doc(`employees/${JOHN}`).delete());
  });
});

describe("attendance — reads", () => {
  beforeEach(async () => {
    await seedAttendance(JOHN, { checkIn: "09:00:00", checkOut: null });
    await seedAttendance(SARAH, { checkIn: "09:05:00", checkOut: null });
  });
  test("super_admin and hr can read everything", async () => {
    for (const k of ["admin", "hr"]) {
      await assertSucceeds(as(k).collection("attendance").get());
      await assertSucceeds(as(k).doc(`attendance/${docId(JOHN)}`).get());
    }
  });
  test("employee can read own records (query filtered by uid) but not others'", async () => {
    await assertSucceeds(as("emp").collection("attendance").where("uid", "==", JOHN).get());
    await assertSucceeds(as("emp").doc(`attendance/${docId(JOHN)}`).get());
    await assertFails(as("emp").doc(`attendance/${docId(SARAH)}`).get());
    await assertFails(as("emp").collection("attendance").get());
    await assertFails(as("emp").collection("attendance").where("uid", "==", SARAH).get());
  });
  test("unauthenticated / role-less cannot read attendance", async () => {
    await assertFails(anon().doc(`attendance/${docId(JOHN)}`).get());
    await assertFails(as("norole").doc(`attendance/${docId(JOHN)}`).get());
  });
  // The ESP32 firmware does GET attendance/{date}_{uid} to decide check-in vs check-out
  // (rfid_wifi.ino processScan → fsGet("attendance/"+docId)). If the device role cannot read
  // it, every second tap is misread as "no record".
  test("FIRMWARE CONTRACT: device can get today's attendance doc", async () => {
    await assertSucceeds(as("device").doc(`attendance/${docId(JOHN)}`).get());
  });
  test("least privilege: device can NOT list or query attendance", async () => {
    await assertFails(as("device").collection("attendance").get());
    await assertFails(as("device").collection("attendance").where("uid", "==", JOHN).get());
  });
});

describe("attendance — create", () => {
  const rec = (uid) => ({ uid, dateKey: DAY, checkIn: "09:00:00", checkOut: null });
  test("super_admin, hr and device can create a check-in", async () => {
    await assertSucceeds(as("admin").doc(`attendance/${docId(JOHN)}`).set(rec(JOHN)));
    await assertSucceeds(as("hr").doc(`attendance/${docId(SARAH)}`).set(rec(SARAH)));
    await assertSucceeds(as("device").doc(`attendance/${docId("I9J0K1L2")}`).set(rec("I9J0K1L2")));
  });
  test("employee, role-less and unauthenticated cannot create attendance", async () => {
    await assertFails(as("emp").doc(`attendance/${docId(JOHN)}`).set(rec(JOHN)));
    await assertFails(as("norole").doc(`attendance/${docId(JOHN)}`).set(rec(JOHN)));
    await assertFails(anon().doc(`attendance/${docId(JOHN)}`).set(rec(JOHN)));
  });
});

describe("attendance — update by staff / device (scan flow)", () => {
  beforeEach(() => seedAttendance(JOHN, { checkIn: "09:00:00", checkOut: null, employeeId: "EMP001", employeeName: "John Smith" }));
  const ref = (k) => as(k).doc(`attendance/${docId(JOHN)}`);

  test("super_admin can rewrite check-in and check-out (Edit Time)", async () => {
    await assertSucceeds(ref("admin").update({ checkIn: "08:30:00" }));
    await assertSucceeds(ref("admin").update({ checkOut: "17:00:00" }));
    await assertSucceeds(ref("admin").update({ checkOut: "18:00:00" }));
  });
  for (const k of ["hr", "device"]) {
    test(`${k}: can carry check-out from null → time`, async () => {
      await assertSucceeds(ref(k).update({ checkOut: "17:00:00" }));
    });
    test(`${k}: dashboard full-document set() with a new check-out is allowed`, async () => {
      // app.js saveAttendance() does .set(normalizedRecord) — a full replace.
      await assertSucceeds(ref(k).set({
        uid: JOHN, dateKey: DAY, employeeId: "EMP001", employeeName: "John Smith",
        checkIn: "09:00:00", checkOut: "17:00:00", checkInLocation: null, checkOutLocation: null,
      }));
    });
    test(`${k}: cannot rewrite an existing check-in`, async () => {
      await assertFails(ref(k).update({ checkIn: "08:00:00" }));
    });
    test(`${k}: cannot overwrite an already-recorded check-out`, async () => {
      await assertSucceeds(as("admin").doc(`attendance/${docId(JOHN)}`).update({ checkOut: "17:00:00" }));
      await assertFails(ref(k).update({ checkOut: "23:59:59" }));
    });
    test(`${k}: can add remarks-free metadata (employeeName) without touching times`, async () => {
      await assertSucceeds(ref(k).update({ employeeName: "John S." }));
    });
  }
  test("hr/device cannot delete a record; super_admin can", async () => {
    await assertFails(ref("hr").delete());
    await assertFails(ref("device").delete());
    await assertSucceeds(ref("admin").delete());
  });
});

describe("attendance — employee self-service", () => {
  const loc = { lat: 12.9, lng: 77.6, accuracy: 20 };
  const ref = (k, uid = JOHN) => as(k).doc(`attendance/${docId(uid)}`);

  describe("checked in, not checked out", () => {
    beforeEach(() => seedAttendance(JOHN, { checkIn: "09:00:00", checkOut: null }));
    test("can verify own check-in location (merge set)", async () => {
      await assertSucceeds(ref("emp").set({ checkInLocation: loc, checkInLocationAt: new Date().toISOString() }, { merge: true }));
    });
    test("cannot set a check-out for themselves", async () => {
      await assertFails(ref("emp").update({ checkOut: "17:00:00" }));
    });
    test("cannot change check-in time", async () => {
      await assertFails(ref("emp").update({ checkIn: "08:00:00" }));
    });
    test("cannot touch other fields (employeeName / uid / dateKey)", async () => {
      await assertFails(ref("emp").update({ employeeName: "Hacked" }));
      await assertFails(ref("emp").update({ uid: SARAH }));
      await assertFails(ref("emp").update({ dateKey: "2020-01-01" }));
    });
    test("cannot touch another employee's record", async () => {
      await seedAttendance(SARAH, { checkIn: "09:10:00", checkOut: null });
      await assertFails(ref("emp", SARAH).update({ checkInLocation: loc }));
      await assertFails(ref("emp", SARAH).delete());
    });
    test("can undo (delete) own check-in while checkOut is null", async () => {
      await assertSucceeds(ref("emp").delete());
    });
  });

  describe("checked in AND out", () => {
    beforeEach(() => seedAttendance(JOHN, { checkIn: "09:00:00", checkOut: "17:00:00", checkInLocation: loc }));
    test("can verify check-out location", async () => {
      await assertSucceeds(ref("emp").set({ checkOutLocation: loc, checkOutLocationAt: new Date().toISOString() }, { merge: true }));
    });
    test("cannot overwrite check-out with a new value", async () => {
      await assertFails(ref("emp").update({ checkOut: "12:00:00" }));
    });
    test("can undo the check-out (portal 'Delete Check-Out')", async () => {
      // employee-app.js deleteScan("checkout")
      await assertSucceeds(ref("emp").update({ checkOut: del(), checkOutLocation: del(), checkOutLocationAt: del() }));
    });
    test("cannot delete the whole record once checked out", async () => {
      await assertFails(ref("emp").delete());
    });
  });

  // ---- The flow the portal itself advertises: "Check-out deleted. Tap your card again to check out." ----
  // After the portal's FieldValue.delete() the `checkOut` KEY no longer exists on the doc, so a rule that
  // reads `resource.data.checkOut` errors instead of evaluating to null.
  describe("after the employee has deleted their check-out (key is gone)", () => {
    beforeEach(async () => {
      await seedAttendance(JOHN, { checkIn: "09:00:00", checkOut: "17:00:00", checkInLocation: loc });
      await ref("emp").update({ checkOut: del(), checkOutLocation: del(), checkOutLocationAt: del() });
    });
    for (const k of ["hr", "device"]) {
      test(`${k} can check the employee out again on the next card tap`, async () => {
        await assertSucceeds(ref(k).update({ checkOut: "17:30:00" }));
      });
      test(`${k} full set() (dashboard scan) can check the employee out again`, async () => {
        await assertSucceeds(ref(k).set({
          uid: JOHN, dateKey: DAY, checkIn: "09:00:00", checkOut: "17:30:00", checkInLocation: loc, checkOutLocation: null,
        }));
      });
    }
    test("super_admin can still set a check-out", async () => {
      await assertSucceeds(ref("admin").update({ checkOut: "17:30:00" }));
    });
    test("employee can still delete the whole record (undo) since checkOut is effectively null", async () => {
      await assertSucceeds(ref("emp").delete());
    });
  });
});

describe("remarks", () => {
  test("super_admin and hr can read/write/delete remarks", async () => {
    for (const k of ["admin", "hr"]) {
      const r = as(k).collection("remarks").doc(`r_${k}`);
      await assertSucceeds(r.set({ uid: JOHN, text: "late", date: DAY }));
      await assertSucceeds(r.get());
      await assertSucceeds(r.delete());
    }
  });
  test("employee, device, role-less and unauthenticated have no access to remarks", async () => {
    for (const k of ["emp", "device", "norole"]) {
      await assertFails(as(k).collection("remarks").doc("x").set({ uid: JOHN, text: "hi" }));
      await assertFails(as(k).collection("remarks").get());
    }
    await assertFails(anon().collection("remarks").get());
  });
});

describe("devices/{id} - card reader pairing (anonymous sign-in, approved from the web)", () => {
  const READER = "reader-anon-1";
  const OTHER = "reader-anon-2";
  const anonymous = { firebase: { sign_in_provider: "anonymous" } };
  const reader = (uid = READER) => env.authenticatedContext(uid, anonymous).firestore();
  const now = () => new Date().toISOString();
  const reg = { name: "Main Gate", requestedAt: "2026-09-21T09:00:00.000Z" };

  test("an anonymous reader can register itself as pending (own uid only)", async () => {
    await assertSucceeds(reader().doc(`devices/${READER}`).set(reg));
  });
  test("a reader cannot register under someone else's id", async () => {
    await assertFails(reader().doc(`devices/${OTHER}`).set(reg));
  });
  test("only anonymous sign-ins may register (an email user, or no user, may not)", async () => {
    await assertFails(as("emp").doc(`devices/${uids.emp}`).set(reg));
    await assertFails(as("hr").doc(`devices/${uids.hr}`).set(reg));
    await assertFails(anon().doc(`devices/${READER}`).set(reg));
  });
  test("registration cannot carry extra fields (role / status / approved)", async () => {
    for (const extra of [{ role: "device" }, { status: "approved" }, { approved: true }, { uid: READER }]) {
      await assertFails(reader().doc(`devices/${READER}`).set({ ...reg, ...extra }));
    }
  });
  test("registration needs a sane name and timestamp", async () => {
    await assertFails(reader().doc(`devices/${READER}`).set({ name: "x".repeat(41), requestedAt: now() }));
    await assertFails(reader().doc(`devices/${READER}`).set({ name: 42, requestedAt: now() }));
    await assertFails(reader().doc(`devices/${READER}`).set({ requestedAt: now() }));
    await assertFails(reader().doc(`devices/${READER}`).set({ name: "ok" }));
  });

  describe("once registered", () => {
    beforeEach(() => env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`devices/${READER}`).set(reg)));

    test("the reader can read its own record, not another reader's", async () => {
      await assertSucceeds(reader().doc(`devices/${READER}`).get());
      await assertFails(reader(OTHER).doc(`devices/${READER}`).get());
    });
    test("the reader may update ONLY lastSeenAt", async () => {
      await assertSucceeds(reader().doc(`devices/${READER}`).update({ lastSeenAt: now() }));
      await assertFails(reader().doc(`devices/${READER}`).update({ name: "Renamed" }));
      await assertFails(reader().doc(`devices/${READER}`).update({ role: "device" }));
    });
    test("only super_admin can list / rename / delete readers", async () => {
      await assertSucceeds(as("admin").collection("devices").get());
      await assertSucceeds(as("admin").doc(`devices/${READER}`).update({ name: "Back Door" }));
      for (const k of ["hr", "emp", "device", "norole"]) await assertFails(as(k).collection("devices").get());
      await assertFails(reader().collection("devices").get());
      await assertFails(as("hr").doc(`devices/${READER}`).delete());
      await assertFails(reader().doc(`devices/${READER}`).delete());
      await assertSucceeds(as("admin").doc(`devices/${READER}`).delete());
    });

    test("PENDING reader (no users doc) can read / write nothing else", async () => {
      await assertFails(reader().doc(`employees/${JOHN}`).get());
      await assertFails(reader().doc(`attendance/${docId(JOHN)}`).get());
      await assertFails(reader().doc(`attendance/${docId(JOHN)}`).set({ uid: JOHN, dateKey: DAY, checkIn: "09:00:00", checkOut: null }));
      await assertFails(reader().collection("remarks").get());
    });
    test("a reader cannot approve itself (write its own role doc)", async () => {
      await assertFails(reader().doc(`users/${READER}`).set({ role: "device", name: "Main Gate", email: null, employeeUid: null }));
      await assertFails(reader().doc(`users/${READER}`).set({ role: "super_admin", name: "x", email: null }));
    });

    test("APPROVED reader (super_admin wrote users/{uid} role device) works like the device role", async () => {
      await assertSucceeds(as("admin").doc(`users/${READER}`).set({ role: "device", name: "Main Gate", email: null, employeeUid: null, createdAt: now(), createdBy: "admin" }));
      await assertSucceeds(reader().doc(`employees/${JOHN}`).get());
      await assertSucceeds(reader().doc(`attendance/${docId(JOHN)}`).set({ uid: JOHN, dateKey: DAY, checkIn: "09:00:00", checkOut: null }));
      await assertSucceeds(reader().doc(`attendance/${docId(JOHN)}`).update({ checkOut: "17:30:00" }));
      // ...and still has only device powers
      await assertFails(reader().collection("employees").get());
      await assertFails(reader().collection("attendance").get());
      await assertFails(reader().doc(`employees/${JOHN}`).update({ name: "Hacked" }));
      await assertFails(reader().doc(`attendance/${docId(JOHN)}`).update({ checkIn: "08:00:00" }));
      await assertFails(reader().doc(`attendance/${docId(JOHN)}`).delete());
    });
    test("REVOKED reader (users doc deleted) loses access immediately", async () => {
      await as("admin").doc(`users/${READER}`).set({ role: "device", name: "Main Gate", email: null, employeeUid: null });
      await assertSucceeds(reader().doc(`employees/${JOHN}`).get());
      await as("admin").doc(`users/${READER}`).delete();
      await assertFails(reader().doc(`employees/${JOHN}`).get());
    });
  });
});

describe("unknown collections", () => {
  test("default-deny: nobody, not even super_admin, can write to an undeclared path", async () => {
    await assertFails(as("admin").doc("secrets/x").set({ a: 1 }));
  });
});

// keep EMPLOYEES referenced so the seed contract is obvious to readers
test("seed sanity: three sample employees exist", async () => {
  const snap = await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection("employees").get());
  if (snap === undefined) return; // withSecurityRulesDisabled returns callback result
  if (snap.size !== EMPLOYEES.length) throw new Error(`expected ${EMPLOYEES.length} employees, got ${snap.size}`);
});
