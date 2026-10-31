/* =====================================================================
 * Daman Group — Vehicle Position Tracker · offline copy of the website
 *
 * Keeps the site's own files (page, styles, code, logo) on the phone so it
 * opens at once even on a slow connection. A fresh copy is used whenever
 * the network answers quickly, and the saved copy is refreshed every time.
 * Google Sheet / Apps Script data is never cached here — always live.
 * ===================================================================== */
const CACHE = 'vpt-v69';
const FILES = ['./', './index.html', './styles.css', './app.js', './config.js', './places.js', './roads.js', './tolls.js', './logo.webp', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const FAST_MS = 1500; // wait this long for the network before using the saved copy

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // sheet, script, fonts: straight to the network
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    // asked again every time (no-cache): the browser's own 10-minute copy must not hide a new version of the site
    const fresh = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    e.waitUntil(fresh.catch(() => {}));
    if (!cached) return fresh;
    const slow = new Promise(resolve => setTimeout(() => resolve(cached), FAST_MS));
    return Promise.race([fresh.catch(() => cached), slow]);
  })());
});

// tapping an inbox alert brings the website (or the installed app) to the front
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(self.registration.scope);
  }));
});
