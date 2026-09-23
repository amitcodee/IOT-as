// Manual-testing helper: wipes the LOCAL emulators and seeds test data.
//   node tests/dev-seed.mjs               one login per role + 3 employees + a few days of history
//   node tests/dev-seed.mjs --admin-only  ONLY the Super Admin, nothing else - to try the real chain by hand:
//                                         admin makes an HR, the HR makes an employee, the employee signs in
import { getEnv, resetAndSeed, clearAuth, signUp, ACCOUNTS } from "./helpers.mjs";

if (process.argv.includes("--admin-only")) {
  const env = await getEnv();
  await clearAuth();
  await env.clearFirestore();
  const a = ACCOUNTS.admin;
  const { uid } = await signUp(a.email, a.password);
  await env.withSecurityRulesDisabled((ctx) => ctx.firestore().doc(`users/${uid}`).set({
    email: a.email, name: a.name, role: "super_admin", employeeUid: null, createdAt: new Date().toISOString(), createdBy: "seed",
  }));
  console.log("Seeded ONLY the Super Admin:");
  console.log(`  ${a.email}   ${a.password}   (role=super_admin)`);
  process.exit(0);
}

const { uids } = await resetAndSeed();
const env = await getEnv();

const history = [
  ["2026-09-17", "A1B2C3D4", "09:02:11", "18:05:40"],
  ["2026-09-17", "E5F6G7H8", "09:41:03", "17:52:10"],
  ["2026-09-18", "A1B2C3D4", "09:10:00", "13:00:00"],
  ["2026-09-18", "I9J0K1L2", "08:55:30", "17:30:00"],
  ["2026-09-19", "E5F6G7H8", "09:05:00", "18:00:00"],
];
const names = { A1B2C3D4: ["EMP001", "John Smith"], E5F6G7H8: ["EMP002", "Sarah Johnson"], I9J0K1L2: ["EMP003", "Mike Wilson"] };
await env.withSecurityRulesDisabled(async (ctx) => {
  for (const [dateKey, uid, checkIn, checkOut] of history) {
    await ctx.firestore().doc(`attendance/${dateKey}_${uid}`).set({
      uid, dateKey, employeeId: names[uid][0], employeeName: names[uid][1], checkIn, checkOut,
      checkInLocation: null, checkOutLocation: null,
    });
  }
});

console.log("Seeded. Test logins:");
for (const [k, a] of Object.entries(ACCOUNTS)) console.log(`  ${k.padEnd(7)} ${a.email.padEnd(20)} ${a.password}   role=${a.role} uid=${uids[k]}`);
process.exit(0);
