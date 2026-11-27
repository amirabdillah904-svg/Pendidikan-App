const CACHE_NAME = 'alrifaie-pwa-v21';
const CORE_ASSETS = [
  './',
  './index.html',
  './qr-lib.js',
  './admin-settings-module.js',
  './nfc-qr-module.js',
  './smart-features-module.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './login-school-hero.jpg',
  './login-auth-badge.jpg',
  './login-wali-family.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.url.includes('script.google.com')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
