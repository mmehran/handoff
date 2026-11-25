'use strict';
// Service worker: shows Handoff's push notifications, opens the right chat when one is tapped, answers
// an approval straight from its Allow / Deny buttons, and takes text and photos shared to Handoff
// from other apps. It doesn't cache pages or intercept anything else.

const SHARE_CACHE = 'handoff-share';

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
    actions: Array.isArray(d.actions) ? d.actions : [],
    requireInteraction: !!d.permission, // an approval stays until it is answered
    data: { url: d.url || '/', permission: d.permission || null }
  }));
});

// open (or bring forward) Handoff at a page
async function openPage(url) {
  const open = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).find(c => c.url.startsWith(self.location.origin));
  if (open) {
    await open.focus();
    return open.navigate(url).catch(() => {});
  }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = new URL(data.url || '/', self.location.origin).href;
  if ((e.action === 'allow' || e.action === 'deny') && data.permission) {
    // Allow / Deny on the notification: answer without opening the app. If that can't be done
    // (signed out, already answered, offline), open the chat instead.
    e.waitUntil((async () => {
      try {
        const r = await fetch(`/api/permissions/${encodeURIComponent(data.permission)}`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Handoff': '1' },
          body: JSON.stringify({ allow: e.action === 'allow' })
        });
        if (!r.ok) throw new Error(String(r.status));
      } catch { return openPage(url); }
    })());
    return;
  }
  e.waitUntil(openPage(url));
});

// "Share → Handoff" from another app (manifest share_target): keep what was shared for the New session
// page, which picks it up and clears it. Up to 4 photos, like the photo button.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== '/share') return;
  e.respondWith((async () => {
    try {
      const form = await e.request.formData();
      const cache = await caches.open(SHARE_CACHE);
      for (const key of await cache.keys()) await cache.delete(key);
      const text = ['title', 'text', 'url'].map(k => String(form.get(k) || '').trim()).filter(Boolean)
        .filter((v, i, all) => all.indexOf(v) === i).join('\n');
      const photos = form.getAll('photos').filter(f => f && typeof f === 'object' && /^image\//.test(f.type)).slice(0, 4);
      await cache.put('/shared/text', new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
      await Promise.all(photos.map((f, i) => cache.put(`/shared/photo/${i}`, new Response(f, { headers: { 'Content-Type': f.type } }))));
    } catch { /* nothing usable was shared: the page opens empty */ }
    return Response.redirect('/#/new?shared=1', 303);
  })());
});
