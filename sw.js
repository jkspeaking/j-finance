// Offline copy of the app itself (never your data, which is encrypted in IndexedDB).
// Bump VERSION whenever you upload a new version of the app.
const VERSION = "jm-2026-11-05-7";
const SHELL = [
  "./", "./index.html", "./styles.css", "./config.js", "./js/core.js", "./js/ui.js", "./js/inbox.js", "./js/plan.js", "./js/tax.js", "./js/extras.js", "./manifest.webmanifest",
  "./brand/favicon.ico", "./brand/app-icon-small.svg", "./brand/logo-mark.svg", "./brand/logo-mark-reversed.svg",
  "./brand/app-icon-180.png", "./brand/app-icon-192.png", "./brand/app-icon-512.png", "./brand/app-icon-maskable-512.png",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || req.headers.has("Authorization")) return;   // GitHub and exchange rates always go to the network
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put("./index.html", copy)); return res; })
      .catch(() => caches.match("./index.html")));
    return;
  }
  e.respondWith(caches.open(VERSION).then((cache) => cache.match(req).then((hit) => {
    const fresh = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  })));
});
