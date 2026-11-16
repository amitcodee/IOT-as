// Service worker: lets the dashboard / Employee Portal be installed as an app and open without a
// connection. Network first, so a deploy shows up straight away; the cache is only the offline fallback.
// Firebase traffic (other origins) is never touched.
const CACHE = "techcadd-attendance-v2";
const SHELL = [
  "/index.html", "/employee.html", "/styles.css", "/employee-styles.css",
  "/app.js", "/employee-app.js", "/shifts.js", "/time12.js", "/pwa.js", "/logo.png",
  "/icons/icon-192.png", "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => null));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => null);
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === "navigate") {
          const page = url.pathname.startsWith("/employee") ? "/employee.html" : "/index.html";
          return (await caches.match(page)) || Response.error();
        }
        return Response.error();
      }),
  );
});
