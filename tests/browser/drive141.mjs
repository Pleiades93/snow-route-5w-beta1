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
const PORT = 8949;
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



// drive141: Beta 1.64 (deep-audit F05/F07/R01 + F08) - GPS/defensive round.
// F05: the ACTIVE trail display is scoped to the current clean (storage
// keeps every clean). R01: a GPS callback carrying an older timestamp
// than the last accepted fix is rejected. F07: malformed stored shapes
// (string instead of the times object; a nested string in the side
// timestamps) load without crashing and marking still works. F08: the
// compass lifecycle actually stops.
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
await sleep(3000);
const poll120 = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { const v = await ev(expr); if (v === true) return true; await sleep(300); } return false; };
ok('G0 app boots for the GPS/defensive tests', await poll120(`typeof acceptFix === 'function' && !!map`, 30000));
// R01: fresh fix accepted, then a STALE-timestamp fix must be ignored.
const fix = (lat, lng, ts) => `acceptFix({ coords: { latitude: ${lat}, longitude: ${lng}, accuracy: 10, heading: null, speed: null }, timestamp: ${ts} })`;
await ev(`(() => { ${fix(43.8200, -79.5660, 1700000000000)}; return true; })()`); await sleep(200);
await ev(`(() => { ${fix(43.8201, -79.5661, 1700000060000)}; return true; })()`); await sleep(200);
const before = JSON.parse(await ev(`JSON.stringify({ ts: lastFixTs, pos: gpsPos })`));
await ev(`(() => { ${fix(43.8250, -79.5700, 1700000030000)}; return true; })()`); await sleep(200);
const after = JSON.parse(await ev(`JSON.stringify({ ts: lastFixTs, pos: gpsPos })`));
ok('R01 a stale-timestamp fix is rejected: lastFixTs and the estimate do not move backwards | ' + JSON.stringify({ before, after }), after.ts === 1700000060000 && JSON.stringify(after.pos) === JSON.stringify(before.pos));
// F05: seed a two-clean trail; only the current clean's points may draw.
await poll120(`!!(window.map && map.getSource && map.getSource('trail'))`, 30000);
const nowS = Math.floor(Date.now() / 1000);
await ev(`(() => { trail = [[43.8200, -79.5660, ${nowS - 7200}], [43.8201, -79.5661, ${nowS - 7140}], [43.8202, -79.5662, ${nowS - 60}], [43.8203, -79.5663, ${nowS - 30}]]; runStart = Date.now() - 90000; drawTrail(true); return true; })()`); await sleep(200);
const drawnPts = await ev(`(() => { const d = (map.getSource('trail') || {})._data || { features: [] }; return d.features.reduce((a, f) => a + f.geometry.coordinates.length, 0); })()`);
ok('F05 the active trail draws only the current clean (2 of 4 stored points) | drawn ' + drawnPts, drawnPts === 2);
const storedPts = await ev(`trail.length`);
ok('F05b the stored trail is untouched (the log keeps every clean) | stored ' + storedPts, storedPts === 4);
// F08: compass starts and STOPS with its lifecycle.
await ev(`(() => { try { DeviceOrientationEvent.requestPermission = undefined; } catch (e) {} startCompass(); return true; })()`); await sleep(100);
const cOn = await ev(`compassOn`);
await ev(`(() => { stopCompass(); return true; })()`); await sleep(100);
const cOff = await ev(`compassOn`);
ok('F08 compass lifecycle: on after start, off after stop | on ' + cOn + ' off ' + cOff, cOn === true && cOff === false);
// F07a: the completion-times record is a bare string - the boot used to
// die in the cleanup loop (strict-mode delete on a string).
await ev(`(() => { localStorage.setItem('snowroute.v2.times', JSON.stringify('just-a-string')); return true; })()`);
await send('Page.navigate', { url: 'file://' + DIR + '/' + PAGE }, S);
ok('F07a boot survives a string completion-times record', await poll120(`typeof doneSet !== 'undefined' && typeof doneTimes === 'object' && !Array.isArray(doneTimes)`, 30000));
// F07b: a nested string inside the side timestamps - marking the street
// used to throw in applyPiece under strict mode.
const street = await ev(`(() => { const rec = { p: {}, t: {} }; rec.p.Boddy = pieces.Boddy.slice(); rec.t.Boddy = 'o'; localStorage.setItem('snowroute.v5.sides', JSON.stringify(rec)); return 'Boddy'; })()`);
await send('Page.navigate', { url: 'file://' + DIR + '/' + PAGE }, S);
await poll120(`typeof togglePiece === 'function'`, 30000);
const markRes = await ev(`(() => { try { togglePiece(${JSON.stringify(street)}, 0, 0); return 'ok'; } catch (e) { return 'threw: ' + e.message; } })()`);
ok('F07b boot survives nested-string side timestamps and marking works | street ' + street + ' result ' + markRes, !!street && markRes === 'ok');
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION');
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
