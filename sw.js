/* Minimal service worker: cache-first for the app shell only.
 * Overpass and map tiles always go to the network (OSM policy forbids tile prefetch/offline). */
const CACHE = "booze-compass-v3";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // tiles, Overpass, CDN: network only
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
