const CACHE = 'tracker-v4';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)).catch(()=>caches.match('/index.html')));
});

// ── PUSH NOTIFICATIONS ──────────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {title:'Tracker',body:'Deine Routine wartet!'};
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'tracker',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window'}).then(cs => {
    if(cs.length) { cs[0].focus(); return; }
    clients.openWindow('/');
  }));
});
