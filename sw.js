// Snow Route service worker: lets the page open with NO
// signal, and re-uses map data already fetched (vector styles/tiles/glyphs from
// OpenFreeMap + CARTO, Esri fallback tiles, CDN libraries). Host this file in
// the SAME folder as index.html, over https. Without it the page still works
// online. The activate step deletes this app's older caches (and, once, the
// pre-rename beta caches) so no stale page survives an update.
const CACHE = 'snowroute-shell-v1', TILES = 'snowroute-tiles-v1', MAX_TILES = 3000;   // App identity: own cache names - production and this app share an origin (same Pages domain), and 'snowroute-' does not match production's 'snow5w-' cleanup prefix, so neither app's worker can delete the other's caches
// SEC-1 (external audit, 2026-10-27): the library files are cached ONLY
// through integrity-checked fetches. The old c.add(url) stored ANY ok
// response - a captive-portal page cached as leaflet.js would then be
// refused by the page's own SRI on every load and never refetched:
// a permanent brick. The hashes below must match the page tags exactly;
// build-pages.py asserts that on every build and fails on drift.
const CORE = [
  ['https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css', 'sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V'],
  ['https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj']
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await Promise.all(CORE.map(async ([u, integrity]) => {
      try {
        const res = await fetch(new Request(u, { integrity, mode: 'cors' }));
        if (res && res.ok) await c.put(u, res);
      } catch (err) {}   // integrity failure or no network: cache nothing, the page fetches live instead
    }));
    await c.add(new Request(self.registration.scope, { cache: 'reload' })).catch(() => {});
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // one-time cleanup: the two exact legacy names below are the pre-rename beta caches
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => (k.startsWith('snowroute-') || k === 'snow5wbeta1-shell-v1' || k === 'snow5wbeta1-tiles-v1') && k !== CACHE && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
async function netFirst(r, cacheName) {   // fresh when the network answers fast, cached otherwise
  const c = await caches.open(cacheName);
  let fp; try { fp = fetch(r); } catch (e) { fp = Promise.reject(e); }   // a synchronous throw becomes a rejection the fallback below already handles
  let res = null, netErr = false;
  try { res = await Promise.race([fp, new Promise((_, j) => setTimeout(() => j(new Error('slow')), 3500))]); }
  catch (e) {   // SEC-7: a slow network is still a network - wait for the real answer before surrendering to cache/error. Beta 1.48 (audit B03): for NAVIGATIONS that wait is bounded (a further 5 s) - a connection that never answers at all must not hang the app's start when a cached copy exists; other requests keep the unbounded SEC-7 wait.
    if (r.mode === 'navigate') { try { res = await Promise.race([fp, new Promise((_, j) => setTimeout(() => j(new Error('stalled')), 5000))]); } catch (e2) { netErr = true; } }
    else { try { res = await fp; } catch (e2) { netErr = true; } }
  }
  try {
    if (res && res.ok) { try { await c.put(r, res.clone()); } catch (e) {} return res; }   // NEW-02 (audit 5): awaited + caught like cacheFirst - a failed cache write must never sink a good response or escape as an unhandled rejection
    // Server answered with an error status (503 etc.): prefer a good cached copy
    // (BUG-03, ChatGPT audit #2) - surface the error only when nothing is cached.
    // The app-shell fallback applies ONLY to page navigations (ISSUE-03,
    // audit #2): a map style or data request must never be handed HTML.
    const hitErr = await c.match(r, { ignoreSearch: true }) || (r.mode === 'navigate' ? await c.match(self.registration.scope) : undefined);
    return hitErr || res || Response.error();   // res is null exactly when the network failed outright (netErr) and nothing is cached
  } catch (e) {
    const hit = await c.match(r, { ignoreSearch: true }) || (r.mode === 'navigate' ? await c.match(self.registration.scope) : undefined);
    return hit || Response.error();
  }
}
async function cacheFirst(r, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(r.url || r);
  if (hit) return hit;
  if (cacheName === TILES) {
    // SEC-6d: refetch map data with CORS so the status is VISIBLE - an error
    // page must never be cached as if it were a tile (opaque no-cors responses
    // hid the status and got stored). Uncacheable answers pass through live.
    try {
      const res = await fetch(new Request(r.url, { mode: 'cors' }));
      if (res && res.ok) {
        try {
          await c.put(r.url, res.clone());
          const ks = await c.keys();
          if (ks.length > MAX_TILES) await c.delete(ks[0]);
        } catch (e) {}
      }
      return res;
    } catch (e) {
      try { return await fetch(r); } catch (e2) { return Response.error(); }
    }
  }
  try {
    const res = await fetch(r);
    if (res && (res.ok || res.type === 'opaque')) {
      try {
        await c.put(r.url || r, res.clone());
        if (cacheName === TILES) {
          const ks = await c.keys();
          if (ks.length > MAX_TILES) await c.delete(ks[0]);
        }
      } catch (e) {}   // a failed cache write must not sink a good network response
    }
    return res;
  } catch (e) {
    return Response.error();
  }
}
async function staleWhileRevalidate(r, cacheName, e) {   // Beta 1.41: answer from cache at once, refresh it in the background - for assets whose URL is not versioned (the sprite sheets), where pure cache-first would freeze them forever and netFirst makes a theme flip wait out a network race
  const c = await caches.open(cacheName);
  const hit = await c.match(r);
  const np = fetch(r).then(res => { if (res && res.ok) c.put(r, res.clone()).catch(() => {}); return res; }).catch(() => null);
  if (hit) { if (e) { try { e.waitUntil(np); } catch (err) {} } return hit; } // Beta 1.48 (audit B07): bind the background refresh to the fetch event's lifetime - unbound, the worker may sleep before the cache update lands
  const res = await np;
  return res || Response.error();
}
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const mapHost = u.hostname === 'tiles.basemaps.cartocdn.com' || u.hostname === 'protomaps.github.io'; // Beta 1.33: Protomaps tiles (CARTO-hosted) + glyphs/sprites; the styles themselves are embedded in the page
  if (mapHost && u.pathname.includes('/sprites/') && u.pathname.endsWith('.json')) e.respondWith(staleWhileRevalidate(r, TILES, e));
  else if (mapHost && (u.pathname.endsWith('.json') || u.pathname.includes('/styles/'))) e.respondWith(netFirst(r, TILES));
  else if (mapHost) e.respondWith(cacheFirst(r, TILES));
  else if (u.hostname === 'unpkg.com' || u.hostname === 'cdn.jsdelivr.net') e.respondWith(cacheFirst(r, CACHE));
  else if (r.mode === 'navigate' || u.origin === self.location.origin) e.respondWith(netFirst(r, CACHE));
});
