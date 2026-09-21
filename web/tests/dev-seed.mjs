// Manual-testing helper: wipes the LOCAL emulators and seeds one login per role, three employees,
// and a few days of history so the attendance / calendar screens have something to show.
import { getEnv, resetAndSeed, ACCOUNTS } from "./helpers.mjs";

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
