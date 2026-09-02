import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");

function parseEnv(content) {
  const result = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

export async function loadEnv() {
  try {
    return parseEnv(await readFile(envPath, "utf8"));
  } catch {
    return {};
  }
}

export function getAppConfig(env) {
  return {
    appName: env.APP_NAME || "RFID Attendance",
    firebase: {
      apiKey: env.FIREBASE_API_KEY || "",
      authDomain: env.FIREBASE_AUTH_DOMAIN || "",
      projectId: env.FIREBASE_PROJECT_ID || "",
      storageBucket: env.FIREBASE_STORAGE_BUCKET || "",
      messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || "",
      appId: env.FIREBASE_APP_ID || "",
      measurementId: env.FIREBASE_MEASUREMENT_ID || "",
    },
  };
}
