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


// drive86: v5.51 audit-5 battery (NEW-01, ISSUE-02 snapshot, NEW-03 legacy)
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const exc = () => consoleLog.filter(c => c.type === 'EXCEPTION').length;
const seedReload = async (obj) => {
  await ev(`(() => { for (const k in ${JSON.stringify(obj)}) localStorage.setItem(k, ${JSON.stringify(obj)}[k]); location.reload(); return true; })()`);
  await sleep(3000);
};
await sleep(3000);
// T1 NEW-01 success: clear persists across reload
await seedReload({ 'snow5w.v4.trail': '[[43.81,-79.56,1767225600],[43.82,-79.57,1767225700]]' });
let A = JSON.parse(await ev(`(() => JSON.stringify({ tl: trail.length }))()`));
ok('T1 trail seeded (2 pts)', A.tl === 2);
await ev(`(() => { $('xClr').click(); return true; })()`); await sleep(700);
await ev(`(() => { $('xClr').click(); return true; })()`); await sleep(400);
A = JSON.parse(await ev(`(() => JSON.stringify({ ls: localStorage.getItem('snow5w.v4.trail'), toast: $('toast').textContent }))()`));
ok('T1 clear writes [] to storage', A.ls === '[]');
ok('T1 toast says Trail cleared', A.toast === 'Trail cleared');
await ev(`(() => { location.reload(); return true; })()`); await sleep(3000);
A = JSON.parse(await ev(`(() => JSON.stringify({ tl: trail.length }))()`));
ok('T1 clear survives reload (no resurrection)', A.tl === 0);
// T2 NEW-01 failure: honest toast, pending flag, recovery persists
await ev(`(() => { trail.push([43.81,-79.56,1767225600],[43.82,-79.57,1767225700]); saveTrail();
  window.__origSI = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k, v) { if (k === 'snow5w.v4.trail') throw new Error('quota'); return window.__origSI.call(this, k, v); };
  return true; })()`);
await ev(`(() => { $('xClr').click(); return true; })()`); await sleep(700);
await ev(`(() => { $('xClr').click(); return true; })()`); await sleep(400);
A = JSON.parse(await ev(`(() => JSON.stringify({ toast: $('toast').textContent, dirty: trailDirty, ls: localStorage.getItem('snow5w.v4.trail') }))()`));
ok('T2 toast reports the save failure honestly', /saving failed/.test(A.toast));
ok('T2 clear stays pending (trailDirty)', A.dirty === true);
ok('T2 stored trail untouched by failed clear', A.ls !== '[]');
await ev(`(() => { Storage.prototype.setItem = window.__origSI; flushAux(true); return true; })()`); await sleep(300);
A = JSON.parse(await ev(`(() => JSON.stringify({ ls: localStorage.getItem('snow5w.v4.trail'), dirty: trailDirty }))()`));
ok('T2 after recovery the pending clear persists', A.ls === '[]' && A.dirty === false);
// T3 NEW-03: legacy import drops inherited names
await ev(`(() => { localStorage.clear(); location.reload(); return true; })()`); await sleep(3000);
await ev(`(() => { $('xText').value = JSON.stringify({ app: 'snow5w-backup', v: 1, data: { 'snow5w.v2': JSON.stringify({ constructor: true, Velmar: true, __proto__: true }) } }); doRestore(); return true; })()`);
await sleep(300);
A = JSON.parse(await ev(`(() => JSON.stringify({ ls: localStorage.getItem('snow5w.v2') }))()`));
ok('T3 legacy migration keeps only real streets', A.ls === '["Velmar"]');
await sleep(1500);
A = JSON.parse(await ev(`(() => JSON.stringify({ n: doneSet.size, has: doneSet.has('Velmar') }))()`));
ok('T3 after reload doneSet is exactly {Velmar}', A.n === 1 && A.has);
// T4 ISSUE-02: snapshot read failure aborts honestly, nothing written, no throw
A = JSON.parse(await ev(`(() => { window.__origGI = Storage.prototype.getItem;
  Storage.prototype.getItem = function() { throw new Error('denied'); };
  $('xText').value = JSON.stringify({ app: 'snow5w-backup', v: 1, data: { 'snow5w.v2': '["Angie"]' } });
  let threw = false; try { doRestore(); } catch (e) { threw = true; }
  const toast = $('toast').textContent;
  Storage.prototype.getItem = window.__origGI;
  return JSON.stringify({ threw, toast, ls: localStorage.getItem('snow5w.v2') }); })()`));
ok('T4 doRestore does not throw on snapshot failure', A.threw === false);
ok('T4 toast reports the abort honestly', /nothing was changed/.test(A.toast));
ok('T4 current data untouched', A.ls === '["Velmar"]');
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String((c.args && c.args[0]) || c.text || '').slice(0, 220));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
