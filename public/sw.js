// Bump this version string whenever you deploy changed static files, so old caches get
// cleared out automatically — otherwise returning users could get stuck on stale JS/CSS.
const CACHE_VERSION = 'mijo-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/india-data.js',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls — orders, logins, etc. must always hit the real server (or
  // fail honestly) rather than ever serving cached/stale data for something transactional.
  if (url.pathname.startsWith('/api/')) return;

  // Only handle our own origin; let CDN scripts (Leaflet, Chart.js) load normally.
  if (url.origin !== self.location.origin) return;

  // App shell: network-first, so anyone online always gets the latest deployed version,
  // falling back to the cached copy only when the network request fails.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html')))
  );
});
