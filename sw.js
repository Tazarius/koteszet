// Kötészet – offline gyorsítótár. A VERSION változtatása új kiadást jelent.
const VERSION = "koteszet-v1";
const FILES = [
  "./", "index.html", "app.js", "manifest.webmanifest",
  "vendor/jszip.min.js", "vendor/jspdf.umd.min.js",
  "tess/tesseract.min.js", "tess/worker.min.js",
  "tess/tesseract-core-lstm.wasm.js", "tess/tesseract-core-simd-lstm.wasm.js",
  "lang/hun.traineddata.gz", "fonts/DejaVuSerif.ttf",
  "fonts/literata-latin-400-normal.woff2", "fonts/literata-latin-600-normal.woff2",
  "fonts/literata-latin-ext-400-normal.woff2", "fonts/literata-latin-ext-600-normal.woff2",
  "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-180.png"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});
