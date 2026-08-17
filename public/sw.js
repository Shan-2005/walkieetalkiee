const CACHE_NAME = 'robofest-walkie-v6.0';
const ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css?v=6.0',
  '/js/app.js?v=6.0',
  '/js/socket.js?v=6.0',
  '/js/audio.js?v=6.0',
  '/js/webrtc.js?v=6.0',
  '/js/ptt.js?v=6.0',
  '/js/channels.js?v=6.0',
  '/js/ui.js?v=6.0',
  '/assets/walkie-icon.png',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(err => console.warn('[SW] Cache addAll warning:', err));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseToCache);
        });
        return response;
      }).catch(() => cachedResponse);
    })
  );
});
