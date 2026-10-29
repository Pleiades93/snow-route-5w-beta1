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


// drive83: v5.47 external-audit fix battery (SEC-2, 3, 4, 6a, 9a, 9b)
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const exc = () => consoleLog.filter(c => c.type === 'EXCEPTION').length;
const seedReload = async (obj) => {
  await ev(`(() => { for (const k in ${JSON.stringify(obj)}) localStorage.setItem(k, ${JSON.stringify(obj)}[k]); location.reload(); return true; })()`);
  await sleep(3000);
};
await sleep(3000);
// P1 SEC-3: prototype names must not enter doneSet / doneTimes
await seedReload({ 'snow5w.v2': '["constructor","Velmar"]', 'snow5w.v2.times': '{"Velmar":"2026-01-05T12:00:00.000Z","constructor":"2026-01-05T12:00:00.000Z"}' });
let A = JSON.parse(await ev(`(() => JSON.stringify({ n: doneSet.size, hdr: $('count').textContent, tc: Object.keys(doneTimes).length }))()`));
ok('SEC-3 doneSet excludes "constructor" (size 1)', A.n === 1);
ok('SEC-3 header reads 1 of 34', /1 of 34/.test(A.hdr));
ok('SEC-3 doneTimes excludes "constructor"', A.tc === 1);
// P2 SEC-9b: numeric time is dropped
await seedReload({ 'snow5w.v2': '["Velmar"]', 'snow5w.v2.times': '{"Velmar": 12345}' });
A = JSON.parse(await ev(`(() => JSON.stringify({ tc: Object.keys(doneTimes).length }))()`));
ok('SEC-9b numeric doneTimes dropped', A.tc === 0);
// P3 SEC-2: malformed notes cannot kill the export panel
await seedReload({ 'snow5w.v2': '["Angie","Velmar"]', 'snow5w.v4.notes': '{"Velmar":"x","Angie":[{"k":"deep","at":"2026-01-05T12:00:00.000Z"}]}' });
const e0 = exc();
await ev(`(() => { showX('summary'); return true; })()`);
await sleep(500);
A = JSON.parse(await ev(`(() => JSON.stringify({ open: !$('xport').classList.contains('hidden'), hasFlag: $('xText').value.includes('deep'), velmarNotes: notes.Velmar }))()`));
ok('SEC-2 export panel opens despite poisoned notes', A.open);
ok('SEC-2 valid flag still renders', A.hasFlag);
ok('SEC-2 string notes entry deleted at load', A.velmarNotes === undefined);
ok('SEC-2 no exception from showX', exc() === e0);
// P4 SEC-9a: absurd trail timestamp dropped, GPX export survives
await seedReload({ 'snow5w.v4.trail': '[[43.81,-79.56,1767225600],[43.82,-79.57,1e300]]' });
A = JSON.parse(await ev(`(() => JSON.stringify({ tl: trail.length }))()`));
ok('SEC-9a out-of-range trail point dropped', A.tl === 1);
const e1 = exc();
await ev(`(() => { showX('gpx'); return true; })()`);
await sleep(400);
A = JSON.parse(await ev(`(() => JSON.stringify({ open: !$('xport').classList.contains('hidden'), gpx: $('xText').value.includes('<trkpt') }))()`));
ok('SEC-9a GPX panel opens with trkpt', A.open && A.gpx);
ok('SEC-9a no exception from GPX export', exc() === e1);
// P5 SEC-4: restore survives its own pagehide flush
await ev(`(() => { localStorage.clear(); location.reload(); return true; })()`); await sleep(3000);
await ev(`(() => { trail.push([43.9, -79.9, 1767225600]); trailDirty = true; $('xText').value = JSON.stringify({ app: 'snow5w-backup', v: 1, data: { 'snow5w.v4.trail': '[[43.8,-79.5,1767225600]]' } }); doRestore(); flushAux(true); return true; })()`);
await sleep(300);
A = JSON.parse(await ev(`(() => JSON.stringify({ ls: localStorage.getItem('snow5w.v4.trail') }))()`));
ok('SEC-4 flush after restore does NOT clobber restored trail', A.ls === '[[43.8,-79.5,1767225600]]');
await sleep(1500);   // the restore's reload lands
A = JSON.parse(await ev(`(() => JSON.stringify({ tl: trail.length, lat: trail.length ? trail[0][0] : null }))()`));
ok('SEC-4 after reload, trail is the restored one', A.tl === 1 && A.lat === 43.8);
// P6 SEC-6a: a fully failed prep does not mark itself done
await ev(`(() => { localStorage.removeItem('snow5w.prep.v1'); window.Image = class { set src(v) { setTimeout(() => this.onerror && this.onerror(), 5); } }; prepOfflineMaps(); return true; })()`);
await sleep(2500);
A = JSON.parse(await ev(`(() => JSON.stringify({ prep: localStorage.getItem('snow5w.prep.v1') }))()`));
ok('SEC-6a failed prep leaves PREP_KEY unset (will retry)', A.prep === null);
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String((c.args && c.args[0]) || c.text || '').slice(0, 220));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL');
process.exit(0);
