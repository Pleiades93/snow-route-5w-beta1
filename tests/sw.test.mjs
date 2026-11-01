// Service worker fetch-strategy tests: the worker's cacheFirst/netFirst
// functions from src/sw.js, run in Node with mocked caches/fetch.
// Cases: 200 -> network; 503 + cache -> cache; 503 + no cache -> the 503;
//        network throw + cache -> cache; throw + no cache -> Response.error().
import { readFileSync } from 'fs';

import { fileURLToPath } from 'node:url';
const sw = readFileSync(fileURLToPath(new URL('../src/sw.js', import.meta.url)), 'utf8');
const start = sw.indexOf('async function netFirst');
const end = sw.indexOf("self.addEventListener('fetch'");
if (start < 0 || end < 0) throw new Error('worker functions not found');
const fnSrc = sw.slice(start, end);

const store = new Map();   // url -> Response
const cacheMock = {
  async match(r) { const u = typeof r === 'string' ? r : r.url; return store.get(u); },
  async put(r, res) { const u = typeof r === 'string' ? r : r.url; store.set(u, res); }
};
globalThis.caches = { async open() { return cacheMock; } };
globalThis.self = { registration: { scope: 'https://example.test/app/' } };

let fetchImpl = async () => { throw new Error('unset'); };
globalThis.fetch = (...a) => fetchImpl(...a);
let putThrows = false;
const origPut = cacheMock.put.bind(cacheMock);
cacheMock.put = async (r, res) => { if (putThrows) throw new Error('quota'); return origPut(r, res); };

const constLine = sw.split('\n').find(l => l.startsWith('const CACHE'));
eval(constLine + '\n' + fnSrc + '\nglobalThis.netFirst = netFirst; globalThis.cacheFirst = cacheFirst; globalThis.staleWhileRevalidate = staleWhileRevalidate;');
const netFirst = globalThis.netFirst;
const cacheFirst = globalThis.cacheFirst;
const staleWhileRevalidate = globalThis.staleWhileRevalidate;

const req = new Request('https://example.test/app/');
const cachedResp = new Response('CACHED-SHELL', { status: 200 });
const results = [];
const check = (name, cond) => results.push([name, !!cond]);

// 1. 200 online -> network response, and it gets cached
store.clear();
fetchImpl = async () => new Response('NETWORK-OK', { status: 200 });
let r = await netFirst(req, 'c');
check('200 returns network body', (await r.text()) === 'NETWORK-OK');
check('200 gets cached', store.has(req.url));

// 2. 503 with cache -> cached copy wins
store.clear(); store.set(req.url, cachedResp.clone());
fetchImpl = async () => new Response('SERVER ERROR', { status: 503 });
r = await netFirst(req, 'c');
check('503 + cache returns cached body', (await r.text()) === 'CACHED-SHELL');

// 3. 503 without cache -> the 503 surfaces (honest failure)
store.clear();
fetchImpl = async () => new Response('SERVER ERROR', { status: 503 });
r = await netFirst(req, 'c');
check('503 + no cache returns 503', r.status === 503);

// 4. network throw with cache -> cached copy
store.clear(); store.set(req.url, cachedResp.clone());
fetchImpl = async () => { throw new Error('offline'); };
r = await netFirst(req, 'c');
check('throw + cache returns cached body', (await r.text()) === 'CACHED-SHELL');

// 5. network throw without cache -> Response.error() (type 'error', status 0)
store.clear();
fetchImpl = async () => { throw new Error('offline'); };
r = await netFirst(req, 'c');
check('throw + no cache returns error response', r.type === 'error' || r.status === 0);

// 6. ISSUE-03: a NON-navigation request (map style) failing with only the shell
// cached must NOT be handed the HTML shell.
store.clear(); store.set('https://example.test/app/', cachedResp.clone());
const styleReq = new Request('https://tiles.openfreemap.org/styles/positron');
fetchImpl = async () => new Response('SERVER ERROR', { status: 503 });
r = await netFirst(styleReq, 'c');
check('style 503 + only shell cached returns 503, not HTML', r.status === 503);
fetchImpl = async () => { throw new Error('offline'); };
r = await netFirst(styleReq, 'c');
check('style offline + only shell cached returns error, not HTML', r.type === 'error' || r.status === 0);

// 7. R-11: cache-write failure must not sink a good network response (cacheFirst)
store.clear(); putThrows = true;
const tileReq = new Request('https://server.arcgisonline.com/tile/15/1/2');
fetchImpl = async () => new Response('TILE', { status: 200 });
r = await cacheFirst(tileReq, 'snowroute-tiles-v1');
check('cache write fails -> network response still returned', (await r.text()) === 'TILE');
putThrows = false;

// 8. SEC-7 (v5.47): a SLOW but working network (answers after the 3.5 s race)
// must be awaited and used, not abandoned for an error/cache miss.
store.clear();
fetchImpl = async () => { await new Promise(res => setTimeout(res, 4200)); return new Response('SLOW-OK', { status: 200 }); };
r = await netFirst(req, 'c');
check('SEC-7 slow network response is awaited and returned', (await r.text()) === 'SLOW-OK');
check('SEC-7 slow response gets cached', store.has(req.url));

// 9. SEC-6d (v5.47): tile fetches go through CORS so the status is visible -
// an error tile response is returned but NEVER cached; a good one is cached.
store.clear();
const tileReq2 = new Request('https://server.arcgisonline.com/tile/15/3/4');
fetchImpl = async () => new Response('ERR', { status: 503 });
r = await cacheFirst(tileReq2, 'snowroute-tiles-v1');
check('SEC-6d tile 503 returned, not cached', r.status === 503 && !store.has(tileReq2.url));
fetchImpl = async () => new Response('TILE-OK', { status: 200 });
r = await cacheFirst(tileReq2, 'snowroute-tiles-v1');
check('SEC-6d tile 200 returned and cached', (await r.text()) === 'TILE-OK' && store.has(tileReq2.url));

// 10. NEW-02 (v5.51): a failing cache write on the netFirst path must not sink
// a good network response (and with the write awaited + caught, no unhandled
// rejection can escape).
store.clear(); putThrows = true;
fetchImpl = async () => new Response('NETWORK-OK', { status: 200 });
r = await netFirst(req, 'c');
check('NEW-02 netFirst put fails -> network response still returned', (await r.text()) === 'NETWORK-OK');
putThrows = false;

// 11. Beta 1.48 (audit B03): a NAVIGATION whose network never answers at all
// must fall back to the cached shell within a bounded time, not hang forever.
// (Non-navigations keep the unbounded SEC-7 wait - case 8 still proves it.)
store.clear(); store.set(req.url, cachedResp.clone());
fetchImpl = () => new Promise(() => {});   // never settles
const navReq = { url: req.url, mode: 'navigate' };
const t0 = Date.now();
r = await netFirst(navReq, 'c');
check('B03 stalled navigation falls back to cache', (await r.text()) === 'CACHED-SHELL');
check('B03 fallback is bounded (<20s)', Date.now() - t0 < 20000);

// 12. Beta 1.48 (audit B07): SWR answers from cache at once AND binds the
// background refresh to the fetch event's lifetime; the refresh lands.
store.clear();
const sprReq = new Request('https://protomaps.github.io/sprites/v4/light.json');
store.set(sprReq.url, new Response('SPRITE-OLD', { status: 200 }));
fetchImpl = async () => new Response('SPRITE-NEW', { status: 200 });
let wu = null;
const fakeEv = { waitUntil(p) { wu = p; } };
r = await staleWhileRevalidate(sprReq, 'c', fakeEv);
check('B07 SWR returns cached copy immediately', (await r.text()) === 'SPRITE-OLD');
check('B07 SWR binds refresh with waitUntil', !!wu && typeof wu.then === 'function');
await wu;
check('B07 refresh updates the cache', (await store.get(sprReq.url).text()) === 'SPRITE-NEW');

// 13. Beta 1.57 (second audit, item 2): the tile-eviction counter is seeded
// from the cache's REAL size on the first tile put after a worker wake, so
// the platform stopping the worker can no longer quietly disable the trim.
const tileStore = new Map();
for (let i = 0; i < 24; i++) tileStore.set('https://tiles.basemaps.cartocdn.com/t/' + i, new Response('T'));
const tileCacheMock = {
  async match(r) { const u = typeof r === 'string' ? r : r.url; return tileStore.get(u); },
  async put(r, res) { const u = typeof r === 'string' ? r : r.url; tileStore.set(u, res); },
  async keys() { return [...tileStore.keys()].map(u => ({ url: u })); },
  async delete(r) { const u = typeof r === 'string' ? r : r.url; return tileStore.delete(u); }
};
globalThis.caches = { async open() { return tileCacheMock; } };
delete cacheFirst._n; // simulate a fresh worker
fetchImpl = async () => new Response('TILE-NEW', { status: 200 });
r = await cacheFirst(new Request('https://tiles.basemaps.cartocdn.com/t/new'), 'snowroute-tiles-v1');
check('1.57 seed: counter starts from the real cache size (24 stored + 1 put = 25)', cacheFirst._n === 25);
delete cacheFirst._n; // worker stopped and restarted by the platform
await cacheFirst(new Request('https://tiles.basemaps.cartocdn.com/t/new2'), 'snowroute-tiles-v1');
check('1.57 seed: after a restart the counter re-seeds from the real size (25 + 1 = 26)', cacheFirst._n === 26);

let fail = 0;
for (const [n, ok] of results) { console.log((ok ? 'PASS' : 'FAIL') + '  ' + n); if (!ok) fail++; }
process.exit(fail ? 1 : 0);
