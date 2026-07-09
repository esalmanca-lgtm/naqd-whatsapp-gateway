const CACHE_NAME = 'naqd-gateway-v10';
const ASSETS = [
  './',
  './index.html',
  './naqd-gateway.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png'
];

// Google Fonts, jsPDF & PDF.js (inline PDF preview) URLs to cache
const EXTERNAL_URLS = [
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Core app assets must cache; external CDN libs are best-effort so a CDN
      // hiccup can't block the service-worker update.
      return cache.addAll(ASSETS).then(() => Promise.all(
        EXTERNAL_URLS.map((u) => cache.add(u).catch(() => {}))
      ));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (!e.request.url.startsWith('http')) return;
  
  // Skip API calls so we always fetch fresh live database updates
  if (e.request.url.includes('/api/') || e.request.url.includes('/chat/') || e.request.url.includes('/message/')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch fresh copy in the background (stale-while-revalidate)
        fetch(e.request).then((networkResponse) => {
          if (networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, networkResponse));
          }
        }).catch(() => {/* Offline fallback */});
        return cachedResponse;
      }
      
      return fetch(e.request).then((networkResponse) => {
        if (networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, responseClone));
        }
        return networkResponse;
      });
    })
  );
});

// ===== WEB PUSH =====
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {
    try { data = { title: 'NAQD Gateway', body: e.data.text() }; } catch (e2) { data = {}; }
  }
  const title = data.title || 'NAQD Gateway';
  const options = {
    body: data.body || 'New activity',
    icon: data.icon || './icon-192.png',
    badge: './icon-192.png',
    tag: data.tag || undefined,          // same tag replaces an earlier notification for that chat
    renotify: !!data.tag,
    data: { url: data.url || './', jid: data.jid || null },
    vibrate: [80, 40, 80]
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const jid = (e.notification.data && e.notification.data.jid) || null;
  const base = (e.notification.data && e.notification.data.url) || './';
  const target = jid ? (base + '#openchat=' + encodeURIComponent(jid)) : base;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
      // App already open → focus it and tell it which chat to open
      for (const c of cls) {
        if ('focus' in c) { c.focus(); if (c.postMessage) c.postMessage({ type: 'open-chat', jid: jid }); return; }
      }
      // App closed → open it with the chat in the URL hash
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
