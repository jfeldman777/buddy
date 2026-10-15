// Bump CACHE_VERSION whenever the app shell changes, so installed clients drop the old cache.
const CACHE_VERSION = 'buddy-v2';

const APP_SHELL = [
  './',
  'index.html',
  'declarations.html',
  'styles.css',
  'app.js',
  'pwa.js',
  'chat.js',
  'dialogue.js',
  'storage.js',
  'speech.js',
  'declarations.js',
  'declarations.json',
  'manifest.webmanifest',
  'qr.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Network first, cache as offline fallback: online users always get the current version.
// cache: 'no-cache' revalidates with the server, bypassing GitHub Pages' 10-minute HTTP cache.
// A navigate Request cannot be re-created with init options, so navigations are fetched by URL.
function fetchFresh(request) {
  return request.mode === 'navigate' ? fetch(request.url, { cache: 'no-cache' }) : fetch(request, { cache: 'no-cache' });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetchFresh(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      }),
  );
});
