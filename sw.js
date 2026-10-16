const CACHE_NAME = 'apitrack-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=4',
  './app.js?v=3',
  './sync.js?v=1',
  './config.js?v=1',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './sample_images.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('apitrack-') && k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Primero la red (para recibir siempre la última versión) y la caché si no hay conexión.
// Google (inicio de sesión y Drive) nunca pasa por la caché.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then((response) => {
      if (response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
      }
      return response;
    }).catch(() =>
      caches.match(req).then((cached) => cached || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))
    )
  );
});
