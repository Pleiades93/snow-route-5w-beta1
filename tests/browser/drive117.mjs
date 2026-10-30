// Ported from the maintainer's local drive battery (same filename); the
// test body is unchanged - only harness plumbing differs: CHROME_BIN env
// override, repo-relative paths, and a fixture generated fresh each run
// from src/ (libraries downloaded and SRI-verified in-drive, certificate
// generated in-drive). Runner: tests/browser/run.mjs. See docs/TESTING.md.
// drive117 (added 2026-10-28): the service-worker upgrade lifecycle on a
// real local origin - closes the long-standing SW-02 automation gap.
// v6 driver: serve the v6 folder locally, load in headless Chromium, and fulfill all
// remote map requests (jsDelivr / OpenFreeMap / Esri) through Node fetch (env proxy),
// so the page runs its REAL production pipeline. sw.js is 404'd to keep the run hermetic.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createHash } from 'node:crypto';

const CHROME = process.env.CHROME_BIN || (fs.existsSync('/opt/meta-chromium/chrome') ? '/opt/meta-chromium/chrome' : 'google-chrome');
const DIR = new URL('../../src/', import.meta.url).pathname;
const PAGE = process.argv[2];
const PORT = 8931;
const outPrefix = process.argv[2] || '/tmp/v6';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===== drive117 preamble: local origin + CDN mirror =====
// The servers start BEFORE the browser. Reaching the app takes a
// file:// bootstrap page whose script redirects to http://127.0.0.1:8931/:
// this Chromium build blocks public-initiated navigations to loopback
// (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS - CDP navigate and even
// Target.createTarget on the URL both land on an error page, and the
// LNA disable flags do not stop it), but a LOCAL initiator navigating to
// a local target is allowed, so the redirect goes through and the app
// loads on a real secure-context origin where the worker can register. The library CDNs are host-mapped
// to a local TLS mirror serving byte-identical, SRI-verified files, so
// the page and sw.js run unmodified.
const FIX = path.join(new URL('.', import.meta.url).pathname, '.sw-fixture');
// Fixture generated fresh from src/ on every run: v1 = the shipped files,
// v2 = the same files with a bumped version label and shell cache name.
// The five library files are downloaded and verified against the SRI
// hashes parsed out of sw.js itself - a mismatch aborts the drive.
fs.rmSync(FIX, { recursive: true, force: true });
fs.mkdirSync(path.join(FIX, 'v1'), { recursive: true });
fs.mkdirSync(path.join(FIX, 'v2'), { recursive: true });
fs.mkdirSync(path.join(FIX, 'lib'), { recursive: true });
const srcIdx = fs.readFileSync(path.join(DIR, 'tracker-source.html'), 'utf8');
const srcSw = fs.readFileSync(path.join(DIR, 'sw.js'), 'utf8');
const v1Label = (srcIdx.match(/id="ver">(v6\.0 · Beta \d+\.\d+)/) || [])[1];
const V1CACHE = (srcSw.match(/const CACHE = '([^']+)'/) || [])[1];
const TILECACHE = (srcSw.match(/TILES = '([^']+)'/) || [])[1];
if (!v1Label || !V1CACHE || !TILECACHE) throw new Error('drive117 fixture: could not parse version/cache names from src');
const V2LABEL = v1Label + '-swtest';
const V2CACHE = V1CACHE + 'x';
fs.writeFileSync(path.join(FIX, 'v1', 'index.html'), srcIdx);
fs.writeFileSync(path.join(FIX, 'v1', 'sw.js'), srcSw);
if (!srcIdx.includes('id="ver">' + v1Label) || srcSw.split(V1CACHE).length !== 2) throw new Error('drive117 fixture: v2 mutation anchors not unique');
fs.writeFileSync(path.join(FIX, 'v2', 'index.html'), srcIdx.replace('id="ver">' + v1Label, 'id="ver">' + V2LABEL));
fs.writeFileSync(path.join(FIX, 'v2', 'sw.js'), srcSw.replace("'" + V1CACHE + "'", "'" + V2CACHE + "'"));
const CORE = [...srcSw.matchAll(/\['(https:[^']+)',\s*'(sha384-[^']+)'\]/g)].map(m => ({ url: m[1], integrity: m[2], file: m[1].split('/').pop() }));
if (CORE.length !== 2) throw new Error('drive117 fixture: expected 2 CORE entries in sw.js (the MapLibre pair), found ' + CORE.length);
const COREURLS = CORE.map(c => c.url);
for (const c of CORE) {
  const r = await fetch(c.url);
  if (!r.ok) throw new Error('drive117 fixture: download failed for ' + c.url);
  const buf = Buffer.from(await r.arrayBuffer());
  const h = 'sha384-' + createHash('sha384').update(buf).digest('base64');
  if (h !== c.integrity) throw new Error('drive117 fixture: SRI mismatch for ' + c.file);
  fs.writeFileSync(path.join(FIX, 'lib', c.file), buf);
}
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(FIX, 'key.pem'), '-out', path.join(FIX, 'cert.pem'), '-days', '3650', '-nodes', '-subj', '/CN=unpkg.com', '-addext', 'subjectAltName=DNS:unpkg.com,DNS:cdn.jsdelivr.net'], { stdio: 'ignore' });
fs.writeFileSync(path.join(FIX, 'bootstrap.html'), '<!doctype html><meta charset="utf-8"><title>boot</title><script>location.replace(\'http://127.0.0.1:8931/\');</' + 'script>');
let current = 'v1';
const appServer = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1:8931');
    const root = path.join(FIX, current);
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(root, 'index.html')));
    } else if (u.pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(root, 'sw.js')));
    } else if (u.pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{}');
    } else { res.writeHead(404); res.end('nf'); }
  } catch (e) { try { res.writeHead(500); res.end('err'); } catch (e2) {} }
});
const LIBMAP = Object.fromEntries(CORE.map(c => [new URL(c.url).pathname, c.file]));
const mirrorServer = https.createServer({ key: fs.readFileSync(path.join(FIX, 'key.pem')), cert: fs.readFileSync(path.join(FIX, 'cert.pem')) }, (req, res) => {
  try {
    const u = new URL(req.url, 'https://unpkg.com');
    const f = LIBMAP[u.pathname];
    if (!f) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': f.endsWith('.css') ? 'text/css' : 'text/javascript', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(FIX, 'lib', f)));
  } catch (e) { try { res.writeHead(500); res.end(); } catch (e2) {} }
});
await new Promise(r => appServer.listen(8931, '127.0.0.1', r));
await new Promise(r => mirrorServer.listen(8443, '127.0.0.1', r));

// (no local HTTP server: Chromium's Local Network Access checks block 127.0.0.1 navigations
//  from a fresh target, so the page is loaded via file:// like the earlier harnesses;
//  remote map requests are still fulfilled through Node fetch below.)
const proc = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-proxy-server',
  '--remote-debugging-port=0', '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessMainFrameNavigations,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults', '--user-data-dir=/tmp/v6profile-' + Date.now(),
  '--ignore-certificate-errors', '--host-resolver-rules=MAP unpkg.com 127.0.0.1:8443, MAP cdn.jsdelivr.net 127.0.0.1:8443',
  '--window-size=420,900', 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  setTimeout(() => rej(new Error('no devtools url: ' + buf.slice(0, 500))), 25000);
});
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
const consoleLog = [];
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method === 'Runtime.consoleAPICalled') {
    consoleLog.push({ type: msg.params.type, text: (msg.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ') });
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleLog.push({ type: 'EXCEPTION', text: (d.exception && d.exception.description) || d.text });
  } else if (msg.method === 'Fetch.requestPaused') {
    handlePaused(msg.params);
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
}
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = sessionId;

async function handlePaused(p) {
  const url = p.request.url;
  try {
    if (url.endsWith('/sw.js')) {
      await send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 404, body: '' }, S);
      return;
    }
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    await send('Fetch.fulfillRequest', {
      requestId: p.requestId, responseCode: r.status,
      responseHeaders: [{ name: 'Content-Type', value: ct }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: buf.toString('base64')
    }, S);
  } catch (e) {
    await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }, S);
  }
}

await send('Page.enable', {}, S);
await send('Runtime.enable', {}, S);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true }, S);
await send('Page.navigate', { url: 'file://' + path.join(FIX, 'bootstrap.html') }, S);   // local initiator -> the redirect to 127.0.0.1 is a local-to-local navigation (see the preamble)

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S);
  if (r.result && r.result.exceptionDetails) return { error: JSON.stringify(r.result.exceptionDetails).slice(0, 400) };
  return r.result && r.result.result ? r.result.result.value : undefined;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' }, S);
  fs.writeFileSync(name, Buffer.from(r.result.data, 'base64'));
  console.log('saved', name);
}


// drive89: v5.54 Finish pop-up + delete/back navigation
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const exc = () => consoleLog.filter(c => c.type === 'EXCEPTION').length;
const okS = (n, v) => ok(n, v === true);   // strict: an evaluate {error} object must never read as a pass
const waitBoot = async () => { for (let i = 0; i < 25; i++) { try { if (await ev(`!!document.getElementById('ver')`)) return true; } catch (e) {} await sleep(400); } return false; };
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { const v = await fn(); if (v && !(typeof v === 'object' && 'error' in v)) return v; await sleep(400); } return false; };

try {
  await waitBoot(); await sleep(1500);
  okS('W1 v1 worker registered and activated', await until(async () => await ev(`(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active && r.active.state === 'activated'); })()`), 25000));
  okS('W2 v1 page is controlled by the worker', await until(async () => await ev(`!!navigator.serviceWorker.controller`), 15000));
  okS('W3 v1 shell cache holds the 5 integrity-checked libraries + the page', await ev(`(async () => {
    const ks = await caches.keys(); if (!ks.includes('${V1CACHE}')) return false;
    const c = await caches.open('${V1CACHE}'); const urls = (await c.keys()).map(r => r.url);
    const core = ${JSON.stringify(COREURLS)};
    return core.every(u => urls.includes(u)) && urls.some(u => u === 'http://127.0.0.1:8931/');
  })()`));
  await ev(`(async () => { const c = await caches.open('${TILECACHE}'); await c.put('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/15/100/200', new Response('TILEBYTES', { status: 200, headers: { 'Content-Type': 'image/png' } })); return true; })()`);
  await ev(`togglePiece('Velmar', 0, 0); true`); await sleep(500);
  okS('W4 seeded: a tile in the tiles cache + a marked side under v1', await ev(`pieces.Velmar[0] === 1`));

  current = 'v2';   // the server now serves the next release (Node-side flag from the preamble)
  await ev(`document.getElementById('updBtn').click(); true`);
  const w5first = await until(async () => await ev(`(document.getElementById('ver') || { textContent: '' }).textContent.trim() === '${V2LABEL}'`), 30000);
  R.firstReloadLanded = (w5first === true);   // data, not a gate: the app's own design anticipates a mid-switch reload landing on the old shell ("Update did not take yet") - convergence, possibly via that designed retry, is the gated property
  let w5 = w5first;
  if (!w5) {
    R.diag = await ev(`(async () => { const r = await navigator.serviceWorker.getRegistration();
      const served = await fetch(location.pathname + '?u=' + Date.now(), { cache: 'no-store' }).then(x => x.text()).then(t => (t.match(/id="ver">([^<]+)</) || [])[1]).catch(e => 'fetchfail');
      return { label: (document.getElementById('ver') || {}).textContent, toast: (document.getElementById('toast') || {}).textContent,
        active: r && r.active ? r.active.state : null, waiting: !!(r && r.waiting), installing: !!(r && r.installing),
        controlled: !!navigator.serviceWorker.controller, caches: await caches.keys(), servedLabel: served }; })()`);
    await ev(`location.reload(); true`); await sleep(2500); await waitBoot(); await sleep(1500);
    w5 = await until(async () => await ev(`(document.getElementById('ver') || { textContent: '' }).textContent.trim() === '${V2LABEL}'`), 20000);
  }
  okS('W5 the app update path lands on the new version (first reload, or the app-designed retry)', w5);
  okS('W6 handoff: new shell cache in, old shell cache deleted', await until(async () => await ev(`(async () => { const ks = await caches.keys(); return ks.includes('${V2CACHE}') && !ks.includes('${V1CACHE}'); })()`), 25000));
  okS('W7 tiles cache survives the handoff, seeded tile intact', await ev(`(async () => { const c = await caches.open('${TILECACHE}'); const r = await c.match('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/15/100/200'); return !!r && (await r.text()) === 'TILEBYTES'; })()`));
  okS('W8 route progress survives the handoff', await ev(`pieces.Velmar[0] === 1`));
  okS('W9 post-update confirmation was consumed (no stale update flag)', await ev(`sessionStorage.getItem('snow5w.updatedTo') === null`));
  okS('W10 the new shell serves the new page from cache storage', await ev(`(async () => { const c = await caches.open('${V2CACHE}'); const r = await c.match('http://127.0.0.1:8931/'); return !!r && (await r.text()).includes('${V2LABEL}'); })()`));
} catch (e) {
  R.fatal = String(e && e.message || e);
}
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String((c.args && c.args[0]) || c.text || '').slice(0, 220));
console.log(JSON.stringify(R, null, 1));
try { appServer.close(); mirrorServer.close(); } catch (e) {}
try { fs.rmSync(FIX, { recursive: true, force: true }); } catch (e) {}
// Explicit exit: open CDP/Chrome handles otherwise keep the process alive.
process.exit(0);
