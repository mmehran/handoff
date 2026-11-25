'use strict';
// Service worker: shows Handoff's push notifications and opens the right chat when one is tapped.
// It doesn't cache or intercept anything else.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Handoff', {
    body: d.body || '',
    tag: d.tag || undefined,          // a newer alert for the same chat replaces the older one
    renotify: !!d.tag,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const open = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).find(c => c.url.startsWith(self.location.origin));
    if (open) {
      await open.focus();
      return open.navigate(url).catch(() => {});
    }
    return self.clients.openWindow(url);
  })());
});
