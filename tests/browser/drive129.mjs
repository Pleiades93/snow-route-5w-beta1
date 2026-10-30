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



// drive129: Beta 1.28 facing cone (Andrew: the Apple Maps light beam on the GPS dot).
// No beam until a facing is known; the beam points along the facing (compass funnel);
// while moving, the GPS course takes over the funnel; GPS off removes the beam.
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const J = async (expr) => { const raw = await ev(`(() => { try { return JSON.stringify((${expr})); } catch (e) { return JSON.stringify({ __err: String(e && e.message || e) }); } })()`); return typeof raw === 'string' ? JSON.parse(raw) : {}; };
await sleep(3000);
const poll120 = async (expr, pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { const v = await ev(expr); if (v === true) return true; await sleep(300); } return false; };
ok('F0 app boots with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true`, v => v, 30000));

const base = JSON.parse(await ev(`(() => { const part = STRETCH.Velmar.parts[0]; const mid = part[Math.floor(part.length / 2)]; return JSON.stringify({ lat: mid[0], lng: mid[1] }); })()`));
const gpsData = async () => JSON.parse(await ev(`(() => { const d = (map.getSource('gps') || {})._data || { features: [] }; return JSON.stringify(d.features.map(f => f.properties.k)); })()`));
const coneBearing = async () => ev(`(() => { const d = map.getSource('gps')._data; const cone = d.features.find(f => f.properties.k === 'cone'); if (!cone) return -1; const cs = cone.geometry.coordinates[0]; const c = cs[0]; let far = null, fd = -1; for (const p of cs) { const dd = Math.hypot((p[0]-c[0]) * 80386, (p[1]-c[1]) * 111320); if (dd > fd) { fd = dd; far = p; } } return Math.round(((Math.atan2((far[0]-c[0]) * 80386, (far[1]-c[1]) * 111320) * 180 / Math.PI) + 360) % 360); })()`);
const bangDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

await ev(`(() => { watchId = 4242; followPaused = false; return true; })()`);
await ev(`acceptFix({ coords: { latitude: ${base.lat}, longitude: ${base.lng}, accuracy: 10, speed: 0, heading: null }, timestamp: Date.now() })`);
await sleep(500);
let K = await gpsData();
ok('C1 a dot with no known facing carries no beam | kinds ' + JSON.stringify(K), K.includes('dot') && !K.includes('cone'));

await ev(`setFacing(90, 1)`); await sleep(200);
K = await gpsData(); const B1 = await coneBearing();
ok('C2 facing east draws the beam pointing east | kinds ' + JSON.stringify(K) + ' bearing ' + B1, K.includes('cone') && bangDiff(B1, 90) <= 7);

await ev(`setFacing(350, 1)`); await sleep(200);
const B2 = await coneBearing();
ok('C3 the beam swings to 350 across the north wrap | bearing ' + B2, bangDiff(B2, 350) <= 7);

for (let i = 0; i < 4; i++) { await ev(`acceptFix({ coords: { latitude: ${base.lat}, longitude: ${base.lng}, accuracy: 9, speed: 6, heading: 90 }, timestamp: Date.now() })`); await sleep(150); }
await sleep(400);
const B3 = await coneBearing();
ok('C4 while moving, the GPS course takes over the beam | bearing ' + B3, bangDiff(B3, 90) <= 20);

const LP = JSON.parse(await ev(`(() => { const l = map.getLayer('gps-cone'); return JSON.stringify({ op: l && map.getPaintProperty('gps-cone', 'fill-opacity') }); })()`));
await ev(`(() => { watchId = null; pushGps(); return true; })()`); await sleep(200);
K = await gpsData();
ok('C5 GPS off removes the beam; the cone layer wears the soft fill | kinds ' + JSON.stringify(K) + ' paint ' + JSON.stringify(LP), !K.includes('cone') && LP.op === 0.3);

R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String(c.text || '').slice(0, 200));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
