const CACHE = 'csbc-draft-v1';
const SHELL = [
  '/draft-tool/',
  '/draft-tool/index.html',
  '/draft-tool/player.html',
  '/draft-tool/app.js',
  '/draft-tool/player.js',
  '/draft-tool/coach-login.js',
  '/draft-tool/coaches-config.js',
  '/draft-tool/firebase.js',
  '/draft-tool/firebase-config.js',
  '/draft-tool/style.css',
  '/draft-tool/icon-192.png',
  '/draft-tool/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for Firebase/Drive/Sheets; cache-first for app shell
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (url.includes('firestore') || url.includes('googleapis') || url.includes('gstatic')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
