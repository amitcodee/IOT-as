// Manual-testing helper: simulate the ESP32 tapping a card, using the same Firestore REST calls as
// hardware/rfid_wifi/rfid_wifi.ino. Usage: node tests/dev-tap.mjs <CARD_UID> [role=hr]
import { signIn, ACCOUNTS, fsFetch } from "./helpers.mjs";

const [uid, role = "hr"] = process.argv.slice(2);
if (!uid) { console.error("usage: node tests/dev-tap.mjs <CARD_UID> [admin|hr|device]"); process.exit(1); }

const now = new Date();
const p = (n) => String(n).padStart(2, "0");
const dateKey = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
const timeStr = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
const { idToken } = await signIn(ACCOUNTS[role].email, ACCOUNTS[role].password);

const emp = await fsFetch(idToken, "GET", `employees/${uid}`);
if (emp.code !== 200) { console.log(`UNKNOWN CARD: ${uid} (HTTP ${emp.code})`); process.exit(0); }
const docId = `${dateKey}_${uid}`;
const att = await fsFetch(idToken, "GET", `attendance/${docId}`);
if (att.code !== 200) {
  const body = JSON.stringify({ fields: { uid: { stringValue: uid }, dateKey: { stringValue: dateKey }, checkIn: { stringValue: timeStr }, checkOut: { nullValue: null } } });
  const w = await fsFetch(idToken, "PATCH", `attendance/${docId}`, { body });
  console.log(w.code === 200 ? `CHECK IN: ${uid} at ${timeStr}` : `Write failed (${w.code}) [read was ${att.code}]`);
  process.exit(0);
}
const at = att.text.indexOf('"checkOut"');
const hasCheckOut = at > 0 && att.text.indexOf('"nullValue"', at) < 0;
if (!hasCheckOut) {
  const w = await fsFetch(idToken, "PATCH", `attendance/${docId}`, { body: JSON.stringify({ fields: { checkOut: { stringValue: timeStr } } }), query: "?updateMask.fieldPaths=checkOut" });
  console.log(w.code === 200 ? `CHECK OUT: ${uid} at ${timeStr}` : `Update failed (${w.code})`);
} else {
  console.log(`ALREADY DONE: ${uid}`);
}
