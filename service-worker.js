const CACHE_NAME = 'boot-route-editor-v18-app-cache';
const TILE_CACHE_NAME = 'boot-route-editor-v18-tile-cache';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './data/custom_network.geojson',
  './data/offline_nederland_simple.geojson',
  './data/offline_vector_sources.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => ![CACHE_NAME, TILE_CACHE_NAME].includes(key))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isOsmTile(url) {
  return url.hostname === 'tile.openstreetmap.org' && /\/\d+\/\d+\/\d+\.png$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isOsmTile(url)) {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((res) => {
            cache.put(req, res.clone()).catch(() => {});
            return res;
          }).catch(() => cached || new Response('', { status: 504, statusText: 'Offline tile niet in cache' }));
        })
      )
    );
    return;
  }

  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => cached || caches.match('./index.html')))
    );
  }
});
