const CACHE = 'tracker-v11';
const ASSETS = ['/tracker/', '/tracker/index.html', '/tracker/manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>{})))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Network first for HTML - always get fresh
  if (e.request.destination === 'document' || e.request.url.endsWith('.html')) {
    e.respondWith(
      fetch(e.request, {cache: 'no-store'})
        .catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {title:'Tracker', body:'Deine Routine wartet!'};
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: '/tracker/icons/icon-192.png',
    badge: '/tracker/icons/icon-192.png', tag: data.tag||'tracker',
    renotify: true, vibrate: [200, 100, 200]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window'}).then(cs => {
    if (cs.length) { cs[0].focus(); return; }
    clients.openWindow('/tracker/');
  }));
});
