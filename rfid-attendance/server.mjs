import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, getAppConfig } from "./lib/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(__dirname, "web");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".woff2", "font/woff2"],
]);

function escapeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

async function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes.get(ext) || "application/octet-stream";
  const data = await readFile(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600",
  });
  res.end(data);
}

function withinWebDir(candidatePath) {
  const normalizedWebDir = path.normalize(webDir + path.sep);
  const normalizedCandidate = path.normalize(candidatePath);
  return normalizedCandidate.startsWith(normalizedWebDir);
}

const env = await loadEnv();
const appConfig = getAppConfig(env);
const port = Number(process.env.PORT || env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/config.js") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(`window.__APP_CONFIG__ = ${escapeScriptJson(appConfig)};`);
      return;
    }

    let relativePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    relativePath = relativePath.replace(/^\/+/, "");

    let filePath = path.normalize(path.join(webDir, relativePath));

    if (!withinWebDir(filePath)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    try {
      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      await serveFile(res, filePath);
      return;
    } catch {
      if (path.extname(requestUrl.pathname)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      await serveFile(res, path.join(webDir, "index.html"));
    }
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Server error: ${error.message}`);
  }
});

server.listen(port, () => {
  console.log(`RFID attendance dashboard running at http://localhost:${port}`);
});