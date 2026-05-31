const CACHE = 'tracker-v10';
const ASSETS = ['/tracker/', '/tracker/index.html', '/tracker/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)).catch(()=>caches.match('/tracker/index.html')));
});
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {title:'Tracker',body:'Deine Routine wartet!'};
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: '/tracker/icons/icon-192.png',
    badge: '/tracker/icons/icon-192.png', tag: data.tag||'tracker',
    renotify: true, vibrate: [200,100,200]
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window'}).then(cs => {
    if(cs.length){ cs[0].focus(); return; }
    clients.openWindow('/tracker/');
  }));
});
