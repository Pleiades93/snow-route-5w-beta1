// Ported from the maintainer's local drive battery (same filename); the
// test body is unchanged - only harness plumbing differs: CHROME_BIN env
// override for the browser path, repo-relative source path, default page.
// Runner: tests/browser/run.mjs. See docs/TESTING.md.
// v6 driver: serve the v6 folder locally, load in headless Chromium, and fulfill all
// remote map requests (jsDelivr / OpenFreeMap / Esri) through Node fetch (env proxy),
// so the page runs its REAL production pipeline. sw.js is 404'd to keep the run hermetic.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = process.env.CHROME_BIN || (fs.existsSync('/opt/meta-chromium/chrome') ? '/opt/meta-chromium/chrome' : 'google-chrome');
const DIR = new URL('../../src/', import.meta.url).pathname;
const PAGE = process.argv[2] || 'tracker-source.html';
const PORT = 8931;
const outPrefix = process.argv[2] || '/tmp/v6';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// (no local HTTP server: Chromium's Local Network Access checks block 127.0.0.1 navigations
//  from a fresh target, so the page is loaded via file:// like the earlier harnesses;
//  remote map requests are still fulfilled through Node fetch below.)
const proc = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-proxy-server',
  '--remote-debugging-port=0', '--disable-features=LocalNetworkAccessChecks', '--user-data-dir=/tmp/v6profile-' + Date.now(),
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
await send('Fetch.enable', { patterns: [
  { urlPattern: '*jsdelivr*', requestStage: 'Request' },
  { urlPattern: '*openfreemap*', requestStage: 'Request' },
  { urlPattern: '*arcgisonline*', requestStage: 'Request' },
  { urlPattern: '*unpkg*', requestStage: 'Request' },
  { urlPattern: '*cartocdn*', requestStage: 'Request' },
  { urlPattern: '*sw.js', requestStage: 'Request' }
] }, S);
await send('Page.enable', {}, S);
await send('Runtime.enable', {}, S);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true }, S);
await send('Page.navigate', { url: 'file://' + DIR + '/' + PAGE }, S);

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



// drive118: audit remediation regression suite (spec 2026-10-29). Covers the gaps the older drives do not:
// invalid coverage indexes (F-2), invalid GPS fixes (G-1), coverage suggestion behaviour incl. parallel
// streets (spec GPS), restore write failure + rollback (suite 5), failed rollback verification (suite 6),
// invalid nested history (suite 3), current-format backup round-trip (suite 1), failed history write at
// finish (suite 11), partial multi-key save consistency (suite 12).
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const J = async (expr) => { const raw = await ev(`(() => { try { return JSON.stringify((${expr})); } catch (e) { return JSON.stringify({ __err: String(e && e.message || e) }); } })()`); return typeof raw === 'string' ? JSON.parse(raw) : {}; };
await sleep(3000);

// T1 (F-2): junk coverage indexes are stripped at load; only true sample indexes survive
await ev(`(() => { localStorage.setItem(LS.cov, JSON.stringify({ Velmar: [-1, 1.5, '3', 99999, 0, 2, 2], Nope: [0, 1] })); location.reload(); return true; })()`);
await sleep(3000);
let A = await J(`({ cov: coveredIdx.Velmar, nope: 'Nope' in coveredIdx })`);
ok('T1 junk coverage indexes stripped (kept [0,2,2])', JSON.stringify(A.cov) === '[0,2,2]');
ok('T1 unknown-street coverage dropped', A.nope === false);

// T2 (G-1): non-finite / off-Earth GPS fixes are rejected before they touch state
A = await J(`(() => { const before = { gps: gpsPos, tl: trail.length };
  const mk = (latitude, longitude) => ({ coords: { latitude, longitude, accuracy: 10, speed: 2, heading: 0 }, timestamp: Date.now() });
  acceptFix(mk(NaN, -79.5)); acceptFix(mk(43.8, Infinity)); acceptFix(mk(91, -79.5)); acceptFix(mk(43.8, -181));
  return { before, after: { gps: gpsPos, tl: trail.length } }; })()`);
ok('T2 invalid fixes rejected (no position, no trail)', A.after && A.after.gps === null && A.after.tl === (A.before ? A.before.tl : 0));

// T3 (suite 9): partial coverage suggests nothing; crossing 85% suggests - and never marks
A = await J(`(() => { let best = null; for (const n of STREETNAMES) if (!best || SAMPLES[n].length < SAMPLES[best].length) best = n;
  coveredIdx = {}; suggested = new Set(); saveAll();
  const pts = SAMPLES[best]; const half = Math.floor(pts.length / 2);
  for (let i = 0; i < half; i++) coverFix(pts[i]);
  const mid = { n: best, total: pts.length, cov: (coveredIdx[best] || []).length, sug: suggested.has(best) };
  for (let i = half; i < pts.length; i++) coverFix(pts[i]);
  return { mid, end: { cov: (coveredIdx[best] || []).length, sug: suggested.has(best), banner: !$('suggest').classList.contains('hidden'), done: doneSet.has(best), complete: streetComplete(best) } }; })()`);
ok('T3 half coverage: no suggestion', A.mid && A.mid.sug === false);
ok('T3 full coverage: suggestion shown', A.end && A.end.sug === true && A.end.banner === true);
ok('T3 suggestion never marks the street', A.end && A.end.done === false && A.end.complete === false);

// T4 (suite 8): a fix on one street does not bleed coverage to a neighbouring street
A = await J(`(() => { coveredIdx = {}; suggested = new Set();
  let pick = null;
  outer: for (const n of STREETNAMES) { for (let i = 0; i < SAMPLES[n].length; i++) { const p = SAMPLES[n][i];
    let dmin = 1e9, dn = null;
    for (const m of STREETNAMES) { if (m === n) continue; for (const q of SAMPLES[m]) { const d = distM(p, q); if (d < dmin) { dmin = d; dn = m; } } }
    if (dmin > 24) { pick = { n, i, p, dn, dmin }; break outer; } } }
  if (!pick) return { err: 'no isolated sample found' };
  coverFix(pick.p);
  const gained = Object.keys(coveredIdx).filter(k => (coveredIdx[k] || []).length);
  return { pick: { n: pick.n, dn: pick.dn, dmin: Math.round(pick.dmin) }, gained }; })()`);
ok('T4 fix covers only its own street (nearest other ' + (A.pick ? A.pick.dmin : '?') + 'm away)', A.gained && A.gained.length === 1 && A.pick && A.gained[0] === A.pick.n);

// T5 (suite 5): a write failure mid-restore rolls everything back and says so
await ev(`(() => { doneSet = new Set(['Velmar']); saveAll();
  window.__bak = buildBackup();
  doneSet = new Set(['Mellings']); saveAll();
  window.__origSI = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k, v) { if (k === LS.sides) throw new Error('quota'); return window.__origSI.call(this, k, v); };
  restoreBackup(JSON.parse(window.__bak));
  return true; })()`);
await sleep(400);
A = await J(`({ toast: $('toast').textContent, done: localStorage.getItem(LS.done) })`);
await ev(`(() => { Storage.prototype.setItem = window.__origSI; return true; })()`);
ok('T5 failed restore reports the rollback', /put back/.test(A.toast || ''));
ok('T5 current data intact after rollback', A.done === '["Mellings"]');

// T6 (suite 6): when the rollback itself cannot be verified, the app says so - never claims success
await ev(`(() => { window.__origGI = Storage.prototype.getItem;
  Storage.prototype.setItem = function(k, v) { if (k === LS.sides) { window.__rbBad = true; throw new Error('quota'); } return window.__origSI.call(this, k, v); };
  Storage.prototype.getItem = function(k) { const v = window.__origGI.call(this, k); return (window.__rbBad && k === LS.done) ? 'corrupted' : v; };
  restoreBackup(JSON.parse(window.__bak));
  return true; })()`);
await sleep(400);
A = await J(`({ toast: $('toast').textContent })`);
await ev(`(() => { Storage.prototype.setItem = window.__origSI; Storage.prototype.getItem = window.__origGI; delete window.__rbBad; return true; })()`);
ok('T6 unverifiable rollback is reported honestly', /could NOT be fully put back/.test(A.toast || ''));

// T7 (suite 3): nested-invalid history in a backup is sanitized on load, valid entries keep their meaning
{
  const iso = new Date(Date.now() - 86400000).toISOString();
  await ev(`(() => { const bad = { app: 'snowroute-backup', v: 1, data: { [LS.hist]: JSON.stringify([
    { at: '${iso}', items: { Velmar: '${iso}' } },
    { at: 'not-a-date', items: { Velmar: null } },
    { at: '${iso}', items: { NopeStreet: null, Velmar: 'garbage-time' } },
    { at: '${iso}', items: { Mellings: null } } ]) } };
    restoreBackup(bad); return true; })()`);
  await sleep(3500); // restore reloads the page
  A = await J(`({ h: history.length, keys: history.map(x => Object.keys(x.items)) })`);
  ok('T7 invalid history entries dropped, valid kept (2)', A.h === 2);
  ok('T7 surviving entries hold only real streets', JSON.stringify(A.keys) === '[["Velmar"],["Mellings"]]');
}

// T8 (suite 1): current-format backup round-trips - state survives export, wipe, restore
await ev(`(() => { localStorage.clear(); location.reload(); return true; })()`); await sleep(3000);
const rtRaw = await ev(`(() => { const n = STREETNAMES.find(x => STRETCH[x].parts.length === 1);
  togglePiece(n, 0, 0); togglePiece(n, 0, 1);
  notes[n] = [{ k: 'hazard', at: new Date().toISOString() }]; saveAll();
  history = [{ at: new Date().toISOString(), items: { [n]: new Date().toISOString() }, via: {}, notes: {}, km: 0 }];
  saveHistory(); return JSON.stringify({ n, bak: buildBackup() }); })()`);
const RT = JSON.parse(rtRaw);
await ev(`(() => { localStorage.clear(); location.reload(); return true; })()`); await sleep(3000);
A = await J(`({ anyDone: STREETNAMES.some(x => streetComplete(x)), h: history.length })`);
ok('T8 wipe really cleared the board first', A.anyDone === false && A.h === 0);
await ev(`(() => { restoreBackup(JSON.parse(${JSON.stringify(RT.bak)})); return true; })()`);
await sleep(3500); // restore reloads the page
A = await J(`({ complete: streetComplete(RT_N), flag: !!(notes[RT_N] && notes[RT_N].some(f => f.k === 'hazard')), h: history.length })`.replaceAll('RT_N', JSON.stringify(RT.n)));
ok('T8 round-trip restores the completed street', A.complete === true);
ok('T8 round-trip restores the flag note', A.flag === true);
ok('T8 round-trip restores the history entry', A.h === 1);

// T9 (suite 11): a failed history write stops the finish - the run stays intact
await ev(`(() => { doneSet = new Set(); doneTimes = {}; doneVia = {}; history = []; // clean slate: T8's restored street otherwise lingers in doneSet and the count reads 4, not 3
  const base = Date.now() - 3600000; runStart = base - 300000; saveStart();
  [['Velmar', 0], ['Mellings', 720000], ['Astona', 1500000]].forEach(([n, off]) => { doneSet.add(n); doneTimes[n] = new Date(base + off).toISOString(); doneVia[n] = 'tap'; });
  refreshAll();
  window.__origSI2 = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k, v) { if (k === LS.hist) throw new Error('quota'); return window.__origSI2.call(this, k, v); };
  $('resetBtn').click(); return true; })()`);
await sleep(300);
await ev(`(() => { $('finYes').click(); return true; })()`); await sleep(400);
A = await J(`({ toast: $('toast').textContent, done: doneSet.size, run: !!runStart, label: $('resetBtn').textContent })`);
await ev(`(() => { Storage.prototype.setItem = window.__origSI2; return true; })()`);
ok('T9 finish stopped honestly on history write failure', /finish stopped/.test(A.toast || ''));
ok('T9 run intact after stopped finish', A.done === 3 && A.run === true && A.label === 'Finish');

// T10 (suite 12): a partial multi-key save cannot leave phantom state after reload
await ev(`(() => { localStorage.clear(); location.reload(); return true; })()`); await sleep(3000);
await ev(`(() => { const n = STREETNAMES.find(x => STRETCH[x].parts.length === 1); window.__pn = n;
  window.__origSI3 = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k, v) { if (k === LS.sides) throw new Error('quota'); return window.__origSI3.call(this, k, v); };
  togglePiece(n, 0, 0); togglePiece(n, 0, 1);
  Storage.prototype.setItem = window.__origSI3;
  location.reload(); return true; })()`);
await sleep(3000);
A = await J(`(() => { const bad = STREETNAMES.filter(x => doneSet.has(x) !== streetComplete(x)); return { bad, pn: window.__pn }; })()`);
ok('T10 after partial save + reload, done set matches street pieces everywhere', A.bad && A.bad.length === 0);

R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String((c.args && c.args[0]) || c.text || '').slice(0, 220));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
