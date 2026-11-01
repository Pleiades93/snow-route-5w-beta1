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
const PORT = 8939;
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
  { urlPattern: '*github.io*', requestStage: 'Request' }, // drive133 only: the Protomaps glyphs/sprites host - without it the local rig (no direct internet) never finishes loading the style, so the GPS sources never appear and the dot/trail assertions cannot run locally; CI fulfils it the same way
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



// drive133: Beta 1.49 recording boundary (Andrew's rule, 2026-10-31).
// The Locate tab alone NEVER records route data: a view-only watch writes no
// trail and no coverage, while still showing the live dot. Recording belongs
// to a clean (Start Clean) and to its own GPS; pressing Locate during an
// open clean resumes that clean's recording; after the clean ends, Locate
// is view-only again.
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
await sleep(3000);
const poll120 = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { const v = await ev(expr); if (v === true) return true; await sleep(300); } return false; };
ok('G0 app boots with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true`));
// (No clear+reload slate-wipe: the harness gives every drive a fresh browser
// profile, so storage starts empty - and a reload would stall the local
// rig's second boot without adding any isolation.)

await ev(`(() => { window.__wpOk = null; navigator.geolocation.watchPosition = (ok2) => { window.__wpOk = ok2; return 4242; }; navigator.geolocation.clearWatch = () => {}; return true; })()`);
const feed = async (lat, lng) => ev('window.__wpOk({ coords: { latitude: ' + lat + ', longitude: ' + lng + ', accuracy: 10, speed: 0, heading: null }, timestamp: Date.now() })'); // string concatenation, not a nested template substitution (drive126's pattern): the nested form inserts the literal text ${lat} into the page, where it is a syntax error and every feed silently dies
const march = async () => { for (const p of PTS) { await feed(p[0], p[1]); await sleep(130); } await sleep(500); };
const PTS = JSON.parse(await ev(`(() => { const L = STRETCH.Velmar.line; return JSON.stringify([12, 15, 18, 21, 24, 27].map(i => L[i])); })()`));
const state = async () => JSON.parse(await ev(`(() => JSON.stringify({ wid: watchId, run: gpsFromRun, clean: !!runStart, trail: trail.length, cov: Object.values(coveredIdx).reduce((a, s) => a + s.length, 0), kinds: ((map.getSource('gps') || {})._data || { features: [] }).features.map(f => f.properties.k) }))()`));

// Phase V: Locate only - live dot, zero recording.
await ev(`startGps(false)`);
await march();
let ST = await state();
ok('V1 view-only watch records no trail and no coverage | ' + JSON.stringify(ST), ST.wid === 4242 && ST.run === false && ST.clean === false && ST.trail === 0 && ST.cov === 0);
ok('V2 the live dot still shows in view-only mode | kinds ' + JSON.stringify(ST.kinds), ST.kinds.includes('dot'));

// Phase R: Start Clean on the already-running watch - recording begins.
await ev(`startClean()`);
await march();
ST = await state();
const trailAfterClean = ST.trail;
ok('R1 a clean records trail and coverage on the same watch | ' + JSON.stringify(ST), ST.run === true && ST.clean === true && ST.trail >= 6 && ST.cov > 0);
const drawn = JSON.parse(await ev(`(() => { const d = (map.getSource('trail') || {})._data || { features: [] }; return JSON.stringify(d.features.length); })()`));
ok('R2 the recorded trail is drawn | features ' + drawn, drawn >= 1);
const recOn = await ev(`$('gpsBtn').classList.contains('rec')`);
ok('R3 the Locate tab wears its recording face (red) when a clean starts on an already-running view-only watch (Beta 1.64, audit F06) | rec ' + recOn, recOn === true);

// Phase S: clean cancelled - Locate is view-only again, nothing more records.
await ev(`cancelStart()`);
await sleep(700);
await ev(`$('gpsBtn').click()`);
await sleep(300);
await march();
ST = await state();
ok('S1 after the clean, Locate is view-only and the trail does not grow | ' + JSON.stringify(ST) + ' was ' + trailAfterClean, ST.run === false && ST.clean === false && ST.trail === trailAfterClean);

// Phase M: Locate pressed during an open clean resumes that clean's GPS.
await ev(`startClean()`);
await ev(`stopGps()`);
await sleep(700);
await ev(`$('gpsBtn').click()`);
await sleep(300);
ST = await state();
ok('M1 Locate during an open clean resumes run GPS | ' + JSON.stringify(ST), ST.clean === true && ST.wid === 4242 && ST.clean === true);
await ev(`stopGps()`);

R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String(c.text || '').slice(0, 200));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
