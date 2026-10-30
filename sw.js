// Offline support. Bump VERSION every time you change ANY file, or phones keep the old copy.
const VERSION = 'tenex-2026-10-29b';
const FILES = [
  './', './index.html', './styles.css', './config.js', './decks.js', './engine.js', './boot.js',
  './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'
];
self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES))));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('message', e => { if (e.data === 'update') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit ||
    fetch(e.request).catch(() => e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())));
});
