const CACHE = 'csbc-draft-v5';
const SHELL = [
  '/draft-tool/',
  '/draft-tool/index.html',
  '/draft-tool/player.html',
  '/draft-tool/rotations.html',
  '/draft-tool/schedule.html',
  '/draft-tool/app.js',
  '/draft-tool/player.js',
  '/draft-tool/rotations.js',
  '/draft-tool/rotations-engine.js',
  '/draft-tool/players-data.js',
  '/draft-tool/schedule.js',
  '/draft-tool/schedule-data.js',
  '/draft-tool/side-menu.js',
  '/draft-tool/coach-login.js',
  '/draft-tool/coaches-config.js',
  '/draft-tool/firebase.js',
  '/draft-tool/firebase-config.js',
  '/draft-tool/style.css',
  '/draft-tool/manifest.json',
  '/draft-tool/icon-192.png',
  '/draft-tool/icon-512.png',
  '/draft-tool/favicon.png',
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

// Network-first for everything — fall back to cache only when offline
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Update cache with fresh response for shell files
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
