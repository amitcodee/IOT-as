// Static checks that need no emulator or browser.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

describe("syntax", () => {
  for (const f of ["server.mjs", "lib/config.mjs", "scripts/build-config.mjs", "public/app.js", "public/employee-app.js"]) {
    test(`node --check ${f}`, () => {
      const r = spawnSync(process.execPath, ["--check", path.join(root, f)], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    });
  }
  test("firebase.json, .firebaserc, indexes are valid JSON; rules declare version 2", () => {
    for (const f of ["firebase.json", ".firebaserc", "firestore.indexes.json"]) JSON.parse(read(f));
    assert.match(read("firestore.rules"), /rules_version\s*=\s*'2'/);
  });
});

describe("folder layout: web/ is deployable on its own, hardware/ is separate", () => {
  test("firebase.json publishes a folder that exists and holds the site; server + config builder use the same one", () => {
    const pub = JSON.parse(read("firebase.json")).hosting.public;
    assert.equal(pub, "public");
    const files = readdirSync(path.join(root, pub));
    for (const f of ["index.html", "employee.html", "app.js", "employee-app.js", "styles.css"]) assert.ok(files.includes(f), `${pub}/${f} missing`);
    assert.match(read("server.mjs"), new RegExp(`path\\.join\\(__dirname, "${pub}"\\)`), "server.mjs serves a different folder");
    assert.match(read("scripts/build-config.mjs"), new RegExp(`"${pub}", "config\\.js"`), "build-config writes config.js elsewhere");
  });

  test("nothing hardware-related is inside the deployed site, and no web code is inside hardware/", () => {
    const pubFiles = readdirSync(path.join(root, "public"));
    assert.ok(!pubFiles.some((f) => /\.(ino|h|py)$/.test(f) || f.startsWith("secrets")), "firmware/secrets files inside public/");
    const hw = readdirSync(path.join(root, "..", "hardware", "rfid_wifi"));
    assert.ok(!hw.some((f) => /\.(html|css|mjs)$/.test(f)), "web files inside hardware/");
    assert.ok(!readdirSync(root).includes("arduino"), "old arduino/ folder still inside web/");
  });

  test("the extra files are gone (Python bridge, stray images, root wrapper package)", () => {
    const repo = path.join(root, "..");
    const top = readdirSync(repo);
    for (const gone of ["test.py", "tce.png", "image.png", "package.json", "rfid-attendance", ".venv", "run.md", "setup.md"]) {
      assert.ok(!top.includes(gone), `${gone} should not be at the repo root`);
    }
  });
});

describe("HTML <-> JS contract: every element id the scripts look up exists in the page", () => {
  const ids = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const cacheIds = (js) => {
    const block = /function cacheElements\(\)\s*\{\s*\[([\s\S]*?)\]\.forEach/.exec(js)[1];
    return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };

  test("app.js cacheElements() ids all exist in index.html", () => {
    const have = ids(read("public/index.html"));
    const missing = cacheIds(read("public/app.js")).filter((i) => !have.has(i));
    assert.deepEqual(missing, [], `ids missing from index.html: ${missing.join(", ")}`);
  });

  test("employee-app.js cacheElements() ids all exist in employee.html", () => {
    const have = ids(read("public/employee.html"));
    const missing = cacheIds(read("public/employee-app.js")).filter((i) => !have.has(i));
    assert.deepEqual(missing, [], `ids missing from employee.html: ${missing.join(", ")}`);
  });

  test("no duplicate ids in either page", () => {
    for (const f of ["public/index.html", "public/employee.html"]) {
      const all = [...read(f).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
      const dupes = all.filter((x, i) => all.indexOf(x) !== i);
      assert.deepEqual(dupes, [], `${f}: duplicate ids ${dupes.join(", ")}`);
    }
  });

  test("local script/link assets referenced by the pages exist", () => {
    const files = new Set(readdirSync(path.join(root, "public")));
    for (const f of ["public/index.html", "public/employee.html"]) {
      for (const m of read(f).matchAll(/(?:src|href)="([^"#?]+)"/g)) {
        const ref = m[1];
        if (/^(https?:)?\/\//.test(ref) || ref.startsWith("/config.js") || ref.endsWith(".html")) continue;
        assert.ok(files.has(ref.replace(/^\//, "")), `${f} references missing asset ${ref}`);
      }
    }
  });

  test("app.js defines every top-level identifier it depends on (sampleEmployees)", () => {
    // index.html loads only config.js + firebase + app.js, so app.js must define its own sampleEmployees.
    assert.match(read("public/app.js"), /(const|let|var)\s+sampleEmployees\b/,
      "app.js uses sampleEmployees but never defines it - 'Load Sample Employees' and local demo mode will throw ReferenceError");
  });
});

describe("lib/config.mjs", () => {
  test("getAppConfig maps env to config and defaults safely", async () => {
    const { getAppConfig } = await import("../lib/config.mjs");
    const c = getAppConfig({ FIREBASE_API_KEY: "k", FIREBASE_PROJECT_ID: "p" });
    assert.equal(c.appName, "RFID Attendance");
    assert.equal(c.firebase.apiKey, "k");
    assert.equal(c.firebase.projectId, "p");
    assert.equal(c.firebase.appId, "");
  });
});

describe("secrets hygiene", () => {
  test(".env and generated public/config.js are gitignored", () => {
    const gi = read(".gitignore");
    assert.match(gi, /^\.env$/m);
    assert.match(gi, /^public\/config\.js$/m);
  });
  test("firmware secrets.h is git-ignored and not tracked (only secrets.h.example is committed)", () => {
    const ignored = spawnSync("git", ["check-ignore", "../hardware/rfid_wifi/secrets.h"], { cwd: root, encoding: "utf8" });
    assert.equal(ignored.status, 0, "../hardware/rfid_wifi/secrets.h is not covered by .gitignore");
    const tracked = spawnSync("git", ["ls-files", "../hardware/rfid_wifi"], { cwd: root, encoding: "utf8" }).stdout.split("\n").map((l) => l.trim());
    assert.ok(!tracked.includes("../hardware/rfid_wifi/secrets.h"), "secrets.h is tracked by git");
    const example = spawnSync("git", ["check-ignore", "../hardware/rfid_wifi/secrets.h.example"], { cwd: root, encoding: "utf8" });
    assert.notEqual(example.status, 0, "secrets.h.example must NOT be ignored - it is the committed template");
    assert.ok(readdirSync(path.join(root, "../hardware/rfid_wifi")).includes("secrets.h.example"), "secrets.h.example is missing");
  });
  test("no real Firebase/WiFi password committed in tracked source", () => {
    // scan the WHOLE repo (web/ and hardware/), not just web/
    const repo = path.join(root, "..");
    const tracked = spawnSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    const offenders = [];
    for (const f of tracked) {
      if (!/\.(ino|h|example|mjs|js|md|py|json|html)$/.test(f) || f.includes("package-lock")) continue;
      let src;
      try { src = readFileSync(path.join(repo, f), "utf8"); } catch { continue; } // deleted in the working tree

      if (/MY_(AUTH|WIFI)_PASS\s+"(?!YOUR_|CHANGE_ME)[^"]+"/.test(src)) offenders.push(f);
    }
    assert.deepEqual(offenders, [], `real-looking passwords committed in: ${offenders.join(", ")}`);
  });
});
