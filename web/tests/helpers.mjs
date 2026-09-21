// Shared helpers for the test suite. Everything here talks to the LOCAL Firebase
// emulators (Auth :9099, Firestore :8080) under the throwaway project "demo-rfid" —
// never to the real Firebase project.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT = "demo-rfid";
export const AUTH_URL = "http://127.0.0.1:9099";
export const FS_HOST = "127.0.0.1";
export const FS_PORT = 8080;
export const FS_REST = `http://${FS_HOST}:${FS_PORT}/v1/projects/${PROJECT}/databases/(default)/documents`;
export const RULES_PATH = path.join(here, "..", "firestore.rules");

export const EMPLOYEES = [
  { uid: "A1B2C3D4", employeeId: "EMP001", name: "John Smith", department: "Engineering", role: "Engineer", phone: "+91 9000000001" },
  { uid: "E5F6G7H8", employeeId: "EMP002", name: "Sarah Johnson", department: "Marketing", role: "Lead", phone: "+91 9000000002" },
  { uid: "I9J0K1L2", employeeId: "EMP003", name: "Mike Wilson", department: "HR", role: "Coordinator", phone: "+91 9000000003" },
];

// One login per role. `employeeUid` links an employee login to an employees/{uid} doc.
export const ACCOUNTS = {
  admin: { email: "admin@test.local", password: "Admin#1234", role: "super_admin", name: "Test Admin" },
  hr: { email: "hr@test.local", password: "Hr#123456", role: "hr", name: "Test HR" },
  emp: { email: "john@test.local", password: "Emp#123456", role: "employee", name: "John Smith", employeeUid: "A1B2C3D4" },
  emp2: { email: "sarah@test.local", password: "Emp#123456", role: "employee", name: "Sarah Johnson", employeeUid: "E5F6G7H8" },
  device: { email: "device@test.local", password: "Dev#123456", role: "device", name: "ESP32 Reader" },
  norole: { email: "norole@test.local", password: "NoRole#123", role: null, name: "No Role" },
};

let env;
export async function getEnv() {
  if (!env) {
    env = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules: readFileSync(RULES_PATH, "utf8"), host: FS_HOST, port: FS_PORT },
    });
  }
  return env;
}

export async function closeEnv() {
  if (env) {
    await env.cleanup();
    env = null;
  }
}

async function authRequest(pathname, body) {
  const res = await fetch(`${AUTH_URL}/identitytoolkit.googleapis.com/v1/${pathname}?key=fake-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`auth ${pathname} failed: ${JSON.stringify(json)}`);
  return json;
}

export async function clearAuth() {
  await fetch(`${AUTH_URL}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
}

export async function signUp(email, password) {
  const j = await authRequest("accounts:signUp", { email, password });
  return { uid: j.localId, idToken: j.idToken };
}

/** What the card reader does on first boot: Firebase anonymous sign-in (no email, no password). */
export async function anonymousSignUp() {
  const res = await fetch(`${AUTH_URL}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  return { code: res.status, text: await res.text() };
}

/** What the reader does on later boots / hourly: trade the stored refresh token for a new ID token. */
export async function refreshTokenExchange(refreshToken) {
  const res = await fetch(`${AUTH_URL}/securetoken.googleapis.com/v1/token?key=fake-key`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
  });
  return { code: res.status, text: await res.text() };
}

export async function signIn(email, password) {
  const j = await authRequest("accounts:signInWithPassword", { email, password });
  return { uid: j.localId, idToken: j.idToken };
}

/**
 * Wipe both emulators and seed: auth users for every account, their users/{uid} role
 * docs (except `norole`), and the three sample employees. Returns { uids: {key: uid} }.
 */
export async function resetAndSeed() {
  await clearAuth();
  const uids = {};
  for (const [key, acct] of Object.entries(ACCOUNTS)) {
    uids[key] = (await signUp(acct.email, acct.password)).uid;
  }
  await reseedFirestore(uids);
  return { uids };
}

/** Wipe Firestore only and re-create the role docs + sample employees for existing auth users. */
export async function reseedFirestore(uids) {
  const e = await getEnv();
  await e.clearFirestore();
  await e.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const emp of EMPLOYEES) await db.doc(`employees/${emp.uid}`).set(emp);
    for (const [key, acct] of Object.entries(ACCOUNTS)) {
      if (!acct.role) continue;
      await db.doc(`users/${uids[key]}`).set({
        email: acct.email,
        name: acct.name,
        role: acct.role,
        employeeUid: acct.employeeUid || null,
        createdAt: new Date().toISOString(),
        createdBy: "seed",
      });
    }
  });
}

// ---- Firestore REST encoding (the ESP32 firmware talks to Firestore over REST) ----

export function fsUrl(pathname, query = "") {
  return `${FS_REST}/${pathname}${query}`;
}

export async function fsFetch(idToken, method, pathname, { body, query } = {}) {
  const res = await fetch(fsUrl(pathname, query || ""), {
    method,
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body,
  });
  return { code: res.status, text: await res.text() };
}

export function todayLocalKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
