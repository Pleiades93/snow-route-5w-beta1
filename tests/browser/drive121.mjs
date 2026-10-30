// drive119 (audit remediation, 2026-10-29 spec items 13/14): TRUE disconnected operation.
// Session 1 (online): the app boots on a real local origin, its service worker installs and takes
// control, the map style lands in the shell cache, and one side of a street is marked.
// The browser is then KILLED and relaunched on the SAME profile with the network emulated OFFLINE:
// the app must boot from its own caches, show the seeded progress, accept a marking offline and
// persist it - and a second offline restart must still show that offline-made mark.
// Plumbing mirrors drive117 (local origin + SRI-verified CDN mirror); the map style/tiles come from
// the real network in session 1, exactly like a first boot on a phone.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createHash } from 'node:crypto';

const CHROME = process.env.CHROME_BIN || (fs.existsSync('/opt/meta-chromium/chrome') ? '/opt/meta-chromium/chrome' : 'google-chrome');
const DIR = new URL('../../src/', import.meta.url).pathname;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FIX = path.join(new URL('.', import.meta.url).pathname, '.sw-fixture');
const PROFILE = '/tmp/v6profile-offline119';
fs.rmSync(FIX, { recursive: true, force: true });
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(path.join(FIX, 'v1'), { recursive: true });
fs.mkdirSync(path.join(FIX, 'lib'), { recursive: true });
const srcIdx = fs.readFileSync(path.join(DIR, 'tracker-source.html'), 'utf8');
const srcSw = fs.readFileSync(path.join(DIR, 'sw.js'), 'utf8');
const V1CACHE = (srcSw.match(/const CACHE = '([^']+)'/) || [])[1];
const TILECACHE = (srcSw.match(/TILES = '([^']+)'/) || [])[1];
if (!V1CACHE || !TILECACHE) throw new Error('drive119 fixture: could not parse cache names from src/sw.js');
fs.writeFileSync(path.join(FIX, 'v1', 'index.html'), srcIdx);
fs.writeFileSync(path.join(FIX, 'v1', 'sw.js'), srcSw);
const CORE = [...srcSw.matchAll(/\['(https:[^']+)',\s*'(sha384-[^']+)'\]/g)].map(m => ({ url: m[1], integrity: m[2], file: m[1].split('/').pop() }));
if (CORE.length !== 2) throw new Error('drive119 fixture: expected 2 CORE entries in sw.js, found ' + CORE.length);
for (const c of CORE) {
  const r = await fetch(c.url);
  if (!r.ok) throw new Error('drive119 fixture: download failed for ' + c.url);
  const buf = Buffer.from(await r.arrayBuffer());
  const h = 'sha384-' + createHash('sha384').update(buf).digest('base64');
  if (h !== c.integrity) throw new Error('drive119 fixture: SRI mismatch for ' + c.file);
  fs.writeFileSync(path.join(FIX, 'lib', c.file), buf);
}
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(FIX, 'key.pem'), '-out', path.join(FIX, 'cert.pem'), '-days', '3650', '-nodes', '-subj', '/CN=unpkg.com', '-addext', 'subjectAltName=DNS:unpkg.com,DNS:cdn.jsdelivr.net'], { stdio: 'ignore' });
fs.writeFileSync(path.join(FIX, 'bootstrap.html'), '<!doctype html><meta charset="utf-8"><title>boot</title><script>location.replace(\'http://127.0.0.1:8931/\');</' + 'script>');
const appServer = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1:8931');
    if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(path.join(FIX, 'v1', 'index.html'))); }
    else if (u.pathname === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(path.join(FIX, 'v1', 'sw.js'))); }
    else if (u.pathname === '/manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{}'); }
    else { res.writeHead(404); res.end('nf'); }
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

const allExceptions = [];
async function launch(offline) {
  const proc = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-proxy-server',
    '--remote-debugging-port=0', '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessMainFrameNavigations,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults', '--user-data-dir=' + PROFILE,
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
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      allExceptions.push(String((d.exception && d.exception.description) || d.text || '').slice(0, 220));
    }
  });
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  };
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = sessionId;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true }, S);
  if (offline) {
    await send('Network.enable', {}, S);
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, S);
  }
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S);
    if (r.result && r.result.exceptionDetails) return { error: JSON.stringify(r.result.exceptionDetails).slice(0, 400) };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Page.navigate', { url: 'file://' + path.join(FIX, 'bootstrap.html') }, S);
  return { proc, ws, ev, send };
}
// Graceful shutdown so on-disk storage (localStorage LevelDB) commits before the next launch
// reads the profile - a bare SIGKILL right after a write can lose it (S2/S3 failures, run #21).
async function closeBrowser(b) {
  try { b.send('Browser.close'); } catch (e) {}
  for (let i = 0; i < 24 && b.proc.exitCode === null; i++) await sleep(250);
  if (b.proc.exitCode === null) { try { b.proc.kill('SIGKILL'); } catch (e) {} }
  await sleep(600);
}
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { const v = await fn(); if (v && !(typeof v === 'object' && 'error' in v)) return v; await sleep(400); } return false; };
const waitBoot = async (ev, ms) => !!(await until(async () => await ev(`!!document.getElementById('ver')`), ms || 25000));

const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const okS = (n, v) => ok(n, v === true);

// ---- Session 1: online boot, worker control, style cached, seed one marked side ----
// ---- the FROZEN FIXTURE ------------------------------------------------------
// A complete dataset in the exact shapes the current writers produce, frozen as a
// literal at Stage 3 (Beta 1.17). If a future format change makes this fixture fail
// to load losslessly, that IS the upgrade alarm: the change needs a migration, per
// docs/STORAGE-SCHEMA.md. Producing version: Beta 1.17 (2026-10-29).
const T1 = '2026-01-05T12:00:00.000Z', T2 = '2026-01-05T12:20:00.000Z', T3 = '2026-01-05T12:25:00.000Z';
const NAMES34 = ['Angie', 'Astona', 'Bayside', 'Bell Harbour', 'Blackburn', 'Bloomingdale', 'Boddy', 'Bourbon', 'Brownlee', 'Cartwright', 'Columbus', 'Conti', 'Dianawood', 'Ferrari', 'Fifth', 'Flatbush', 'Flushing', 'Frankie', 'Galloway', 'Greenpark', 'Julian', 'Kingsnorth', 'Malden', 'Marconi', 'Mellings', 'Radley', 'Romeo', 'Santa Barbara', 'Tina', 'Topper', 'Valeria', 'Velmar', 'Wilshire', 'Woolacott'];
const fullItems = {}; for (const n of NAMES34) fullItems[n] = T2;
const FIXTURE = {
  'snow5w.v2': JSON.stringify(['Astona', 'Velmar']),
  'snow5w.v2.times': JSON.stringify({ Astona: T3, Velmar: T2 }),
  'snow5w.v2.history': JSON.stringify([
    { at: '2026-01-05T12:30:00.000Z', via: 'manual', items: fullItems, notes: {}, sides: { p: { Velmar: Array(14).fill(3) }, t: {} }, km: 17.67, startedAt: 1767650100000 },
    { at: '2026-01-04T11:00:00.000Z', via: 'gps', items: { Velmar: T2 }, notes: { Velmar: [{ k: 'note', at: T1, text: 'Earlier partial' }] }, sides: { p: { Velmar: [3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, t: {} }, km: 3.1, startedAt: 1767560100000 }]),
  'snow5w.v2.night': 'true',
  'snow5w.v4.notes': JSON.stringify({ Woolacott: [{ k: 'car', at: '2026-01-05T12:10:00.000Z' }, { k: 'note', at: '2026-01-05T12:11:00.000Z', text: 'Bin at the curb' }] }),
  'snow5w.v4.via': JSON.stringify({ Astona: 'manual', Velmar: 'gps' }),
  'snow5w.v4.trail': JSON.stringify([[43.8207, -79.567, 1767650400], [43.821, -79.5675, 1767650460], [43.8213, -79.568, 1767650520]]),
  'snow5w.v4.cov': JSON.stringify({ Velmar: [0, 1, 2, 3], Woolacott: [0] }),
  'snow5w.v5.start': '1767650300000',
  'snow5w.v5.flip': '0',
  'snow5w.v5.sides': JSON.stringify({ p: { Astona: [3], Velmar: Array(14).fill(3), Woolacott: [3, 1, 0] }, t: { Velmar: { 0: [T1, '2026-01-05T12:01:00.000Z'] }, Woolacott: { 0: [T1, '2026-01-05T12:02:00.000Z'], 1: [T1, null] } } })
};
const FIXJ = JSON.stringify(FIXTURE);

// ---- session 1: the fixture loads losslessly, and a backup round-trips it ----
let b = await launch(false);
await b.navigate(APP_URL, 15000);
ok('S1 fixture-era page boots', await until(async () => { const v = await b.ev(`document.querySelector('#ver')?.textContent || ''`); return /Beta 1\.1[5-9]|Beta 1\.[2-9]/.test(v) || v.includes('Beta'); }, 30000));
await b.ev(`(() => { const F = ${FIXJ}; for (const k of Object.keys(F)) localStorage.setItem(k, F[k]); return true; })()`);
await b.navigate(APP_URL, 15000);
await sleep(1200);
const probe = JSON.parse(await b.ev(`JSON.stringify({
  velmarAll3: pieces.Velmar.length === 14 && pieces.Velmar.every(v => v === 3),
  wool: pieces.Woolacott, done: [...doneSet].sort(),
  pt: pieceTimes.Woolacott[1], hist: history.length, histFull: Object.keys(history[0].items).length,
  notes: (notes.Woolacott || []).length, trail: trail.length, covV: coveredIdx.Velmar ? coveredIdx.Velmar.length : -1,
  runStart, night: document.body.classList.contains('night') })`));
ok('S1 fixture sides decode exactly (Velmar complete, Woolacott partial)', probe.velmarAll3 && JSON.stringify(probe.wool) === '[3,1,0]');
ok('S1 fixture done set + piece times survive', JSON.stringify(probe.done) === '["Astona","Velmar"]' && JSON.stringify(probe.pt) === JSON.stringify([T1, null]));
ok('S1 fixture history survives (2 entries, full run intact)', probe.hist === 2 && probe.histFull === 34);
ok('S1 fixture notes/trail/coverage/run/night survive', probe.notes === 2 && probe.trail === 3 && probe.covV === 4 && probe.runStart === 1767650300000 && probe.night === true);
const rt = JSON.parse(await b.ev(`(() => { const d = JSON.parse(buildBackup()).data; const F = ${FIXJ}; const out = {}; for (const k of Object.keys(F)) { try { out[k] = JSON.stringify(JSON.parse(d[k])) === JSON.stringify(JSON.parse(F[k])); } catch (e) { out[k] = d[k] === F[k]; } } return JSON.stringify(out); })()`));
ok('S1 backup of the fixture state is meaning-identical on all 11 keys', Object.keys(rt).length === 11 && Object.values(rt).every(Boolean));

// ---- session 2: state B backup taken, state A restored, restore interrupted --
await b.ev(`(() => { pieces.Woolacott = [3, 3, 3]; saveAll(); return true; })()`);
const backupB = await b.ev(`buildBackup()`);
await b.ev(`(() => { const F = ${FIXJ}; for (const k of Object.keys(F)) localStorage.setItem(k, F[k]); return true; })()`);
await b.navigate(APP_URL, 15000);
await sleep(1200);
ok('S2 back at fixture state A (Woolacott partial again)', await b.ev(`JSON.stringify(pieces.Woolacott)`) === '"[3,1,0]"');
await b.ev(`(() => { restoreBackup(JSON.parse(${JSON.stringify(backupB)})); return true; })()`);
// The restore has written and verified every key and is inside its 600ms reload
// pause. Kill the browser NOW - the harshest moment to interrupt it.
await closeBrowser(b);

// ---- session 3: relaunch - the restored state must be present -----------------
b = await launch(false);
await b.navigate(APP_URL, 15000);
await sleep(1200);
ok('S3 interrupted restore still landed state B (Woolacott complete)', await b.ev(`JSON.stringify(pieces.Woolacott)`) === '"[3,3,3]"');
ok('S3 restored state is stable across the relaunch boot', await b.ev(`[...doneSet].includes('Woolacott')`));
await closeBrowser(b);

R.exceptions = allExceptions;
console.log(JSON.stringify(R, null, 1));
process.exit(0);
