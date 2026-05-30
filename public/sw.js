// Service Worker – Alltagsbegleiter
const CACHE = 'alltagsbegleiter-v1';
let schedule = [];

self.addEventListener('install', e => {
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Receive routine schedule from app
self.addEventListener('message', e => {
  if (e.data?.type === 'SCHEDULE') {
    schedule = e.data.routines || [];
    registerAlarms();
  }
});

// Check alarms every minute via periodicsync or fallback setInterval via fetch trick
let alarmTimer = null;
function registerAlarms() {
  if (alarmTimer) clearInterval(alarmTimer);
  alarmTimer = setInterval(checkAlarms, 60000);
}
registerAlarms();

function checkAlarms() {
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5);
  schedule
    .filter(r => r.active && r.time === hhmm)
    .forEach(r => {
      self.registration.showNotification('Alltagsbegleiter', {
        body: `Zeit für: ${r.name}`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: `routine-${r.id}`,
        renotify: false,
        data: { url: '/' }
      });
    });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      if (list.length) return list[0].focus();
      return clients.openWindow('/');
    })
  );
});
