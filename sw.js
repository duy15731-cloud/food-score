// Service worker: caches the app shell so it opens instantly / offline.
// The cache name comes from version.js (the ONE version constant) — a new version = a new cache.
importScripts('./version.js');
const CACHE = 'food-score-' + self.APP_VERSION;
const SHELL = ['./', './index.html', './version.js', './manifest.json', './css/app.css', './js/app.js', './js/engine.js', './js/i18n.js', './js/diet.js', './js/tracker.js', './js/config.js', './js/prices.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
  './vendor/zxing/zxing-reader.js', './vendor/zxing/zxing_reader.wasm'];

self.addEventListener('install', (e) => {
  // cache: 'reload' = straight from the server, never the phone's 10-minute HTTP copies. Without it an update
  // published minutes after the last one could cache a MIX of old and new files that do not fit together
  // (the iPhone app froze on 2026-10-10 and had to be reinstalled). The cached version.js must also say
  // this version, or the install fails and is retried later instead of activating a mixed set.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))
    .then(() => c.match('./version.js')).then((r) => r && r.text()).then((txt) => {
      if (!txt || !txt.includes(self.APP_VERSION)) return caches.delete(CACHE).then(() => { throw new Error('mixed versions while caching'); });
    })));
  // no skipWaiting here: the page shows "new version available, tap to update" and asks us to.
});
self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('food-score-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // Open Food Facts etc. go straight to the network
  if (req.mode === 'navigate') {
    // this version's own copy only (a global caches.match could hand back another version's page)
    e.respondWith(caches.open(CACHE).then((c) => c.match('./index.html')).then((r) => r || fetch(req)));
    return;
  }
  // cache-first; files fetched later (the OCR engine) are added to the cache on first use
  e.respondWith(caches.open(CACHE).then((c) => c.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && url.pathname.includes('/vendor/')) c.put(req, res.clone());
    return res;
  }))));
});
