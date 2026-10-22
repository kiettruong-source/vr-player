// Offline iPad app: answer from the cache at once, refresh the cache in the background,
// so the player opens without a network and picks up new versions on the next launch.
const CACHE = 'vr-player';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'platform.js', 'local.js', 'sphere.js', 'view-math.js',
  'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/gsap.min.js', 'vendor/InertiaPlugin.min.js', 'vendor/three/three.module.js', 'vendor/three/three.core.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;   // blob: videos never come here
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((r) => { if (r.ok) cache.put(req, r.clone()); return r; });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  }));
});
