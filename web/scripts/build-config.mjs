import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, getAppConfig } from "../lib/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "..", "public", "config.js");

function escapeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const env = await loadEnv();
const appConfig = getAppConfig(env);

if (!appConfig.firebase.apiKey) {
  console.warn("Warning: FIREBASE_API_KEY is empty in .env — the deployed site will run in local demo mode.");
}

await writeFile(outPath, `window.__APP_CONFIG__ = ${escapeScriptJson(appConfig)};\n`, "utf8");
console.log(`Wrote ${outPath}`);
