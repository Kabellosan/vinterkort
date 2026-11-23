/* Vinterkort service worker: offline app shell + Android "share to" inbox. */
const VERSION = 'vk-v7';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'drive.js',
  'lib/leaflet.css', 'lib/leaflet.js', 'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/images/layers.png', 'lib/images/layers-2x.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== 'vk-inbox' && k !== 'vk-tiles').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const files = form.getAll('pdf');
      const inbox = await caches.open('vk-inbox');
      let i = 0;
      for (const f of files) {
        await inbox.put(new Request('./inbox/' + Date.now() + '-' + (i++)), new Response(f, { headers: { 'content-type': 'application/pdf', 'x-name': encodeURIComponent(f.name || 'Shared.pdf') } }));
      }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return; // map tiles, address search, Google sign-in and Drive: network only
  // App files: network first (so updates show up right away), cache when offline.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    try {
      const r = await fetch(e.request, { cache: 'no-cache' });
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      return (await c.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  }));
});
