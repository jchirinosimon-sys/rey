const CACHE_NAME = 'asistencia-shell-v11';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/modules.css',
  '/app.js',
  '/qr.js',
  '/pwa.js',
  '/manifest.webmanifest',
  '/icons/dgeti-app-192.png',
  '/icons/dgeti-app-512.png',
  '/icons/logo.svg',
  '/icons/dgeti-logo.png',
  '/icons/dgeti-maskable-192.png',
  '/icons/dgeti-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => /^(gestion-escolar-shell-|asistencia-shell-)/.test(key) && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { data = { title: 'Asistencia', body: 'Tienes un mensaje nuevo.' }; }
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  event.waitUntil(self.registration.showNotification(data.title ?? 'Asistencia', {
    body: data.body ?? 'Tienes un mensaje nuevo.',
    icon: '/icons/dgeti-app-192.png',
    badge: '/icons/dgeti-app-192.png',
    data: { url },
    tag: 'asistencia-' + String(data.id ?? Date.now())
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.navigate(target).then(() => existing.focus());
    return self.clients.openWindow(target);
  }));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(request)) || (await caches.match('/index.html')))
    );
    return;
  }

  event.respondWith(
    fetch(request).then(response => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});

