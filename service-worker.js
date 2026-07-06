const CACHE_NAME = 'boot-route-editor-v15-ipad-pwa';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './data/custom_network.geojson',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      if (new URL(req.url).origin === location.origin) {
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => cached))
  );
});
