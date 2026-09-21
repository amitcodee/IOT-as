// Manual-testing helper: sits in front of the real server.mjs and points the pages at the LOCAL
// Firebase emulators (never the real project). It serves a fake /config.js and injects a snippet
// that makes firebase.initializeApp() call useEmulator(). The app's own files are not modified.
//
//   PORT=3100 node server.mjs            # the real server
//   node tests/dev-proxy.mjs             # then browse http://localhost:3200
import http from "node:http";

const UPSTREAM = process.env.UPSTREAM || "http://localhost:3100";
const PORT = Number(process.env.PROXY_PORT || 3200);

const CONFIG = `window.__APP_CONFIG__ = ${JSON.stringify({
  appName: "RFID Attendance",
  firebase: { apiKey: "fake-key", authDomain: "localhost", projectId: "demo-rfid", appId: "1:1:web:test" },
})};`;

const patch = () => {
  let fb;
  Object.defineProperty(window, "firebase", {
    configurable: true,
    get: () => fb,
    set(v) {
      fb = v;
      const orig = v.initializeApp.bind(v);
      v.initializeApp = (cfg, name) => {
        const app = orig(cfg, name);
        app.auth().useEmulator("http://127.0.0.1:9099", { disableWarnings: true });
        app.firestore().useEmulator("127.0.0.1", 8080);
        return app;
      };
    },
  });
};
const SNIPPET = `<script>(${patch.toString()})()</script>`;

http.createServer(async (req, res) => {
  try {
    if (req.url.split("?")[0] === "/config.js") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(CONFIG);
      return;
    }
    const up = await fetch(UPSTREAM + req.url);
    const type = up.headers.get("content-type") || "application/octet-stream";
    let body = Buffer.from(await up.arrayBuffer());
    if (type.includes("text/html")) {
      body = Buffer.from(body.toString("utf8").replace(/<head>/i, `<head>${SNIPPET}`));
    }
    res.writeHead(up.status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy error: ${e.message}`);
  }
}).listen(PORT, () => console.log(`emulator proxy on http://localhost:${PORT} -> ${UPSTREAM}`));
