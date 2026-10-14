/* Offline support.
   - The app files are stored per version. A new version (new VERSION below) is downloaded in the
     background and waits; the app then offers "update now", which activates it and reloads.
   - Map tiles and fonts are cached as they are viewed.
   Bump VERSION for every release, otherwise devices will not notice the update. */
const VERSION = 'msl-0.3.6';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/texts.js', 'js/app.js', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/jszip.min.js', 'vendor/xlsx.full.min.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];
const TILES = 'msl-tiles', FONTS = 'msl-fonts', MAX_TILES = 3000;

self.addEventListener('install', e => {
  // cache: 'reload' bypasses the browser's HTTP cache, so we really get the new files.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('message', e => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => ![VERSION, TILES, FONTS].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName); const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
async function cacheFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req); if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); if (cacheName === TILES) trim(TILES, MAX_TILES); }
  return res;
}
async function appFile(req) {
  const c = await caches.open(VERSION);
  const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('index.html') : null);
  if (hit) return hit;
  try { return await fetch(req); }
  catch (e) { return req.mode === 'navigate' ? c.match('index.html') : Response.error(); }
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('tile.openstreetmap.org')) return e.respondWith(cacheFirst(req, TILES));
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return e.respondWith(cacheFirst(req, FONTS));
  if (url.origin === location.origin) return e.respondWith(appFile(req));
});
