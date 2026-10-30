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

// drive120 (Stage 2, v1.0 plan): visual-geometry regression for the beta's CURRENT UI shapes.
// Every check measures the FAILURE property directly (overflow, overlap, out-of-bounds) in the
// rendered page at phone size, in both themes - never a proxy like a radius or a class name.
const RECTS = (sel) => `(() => [...document.querySelectorAll('${sel}')].filter(e => e.offsetParent !== null).map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }))()`;
const overlaps = (a, b) => a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1;
const inView = (r) => r.x >= -1 && r.y >= -1 && r.r <= 421 && r.b <= 901;
const noOverlap = (rs) => rs.every((a, i) => rs.every((b, j) => i === j || !overlaps(a, b)));
let A;
const poll120 = async (expr, pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { const v = await ev(expr); if (v === true) return true; await sleep(300); } return false; };

ok('F0 app boots with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true`, v => v, 30000));

// Beta 1.27 (Andrew's drive test): (1) the camera must follow whenever location is
// on - not only during a run; (2) rotate + two-finger pitch gestures, as in the
// prototype; (3) night basemap names lifted off the dark roads.
const G = JSON.parse(await ev(`(() => JSON.stringify({ rot: map.dragRotate.isEnabled(), pitch: map.touchPitch.isEnabled(), tzr: map.touchZoomRotate.isEnabled() }))()`));
ok('F1 rotate and pitch gestures are enabled | ' + JSON.stringify(G), G.rot === true && G.pitch === true && G.tzr === true);
await ev(`(() => { map.setPitch(40); return true; })()`); await sleep(300);
const P = await ev(`Math.round(map.getPitch())`);
ok('F1 the map actually tilts (pitch reaches 40) | pitch ' + P, P === 40);
await ev(`(() => { map.setPitch(0); return true; })()`);

// Follow outside a run: watch on, no run started; fixes march east; the camera
// must ease after them so the dot never leaves the screen.
const base = JSON.parse(await ev(`(() => { const part = STRETCH.Velmar.parts[0]; const mid = part[Math.floor(part.length / 2)]; return JSON.stringify({ lat: mid[0], lng: mid[1] }); })()`));
const feed = async (lat, lng) => ev('acceptFix({ coords: { latitude: ' + lat + ', longitude: ' + lng + ', accuracy: 10, speed: 3, heading: 90 }, timestamp: Date.now() })');
await ev(`(() => { watchId = 4242; followPaused = false; return true; })()`);
await feed(base.lat, base.lng); await sleep(600);                    // first fix (centres once, by design)
await feed(base.lat, base.lng + 0.004); await sleep(500);
await feed(base.lat, base.lng + 0.008); await sleep(500);
await feed(base.lat, base.lng + 0.008);                              // settle the smoothing window on the target
const followed = await poll120(`Math.abs(map.getCenter().lng - ` + (base.lng + 0.008) + `) < 0.0025 && !runStart`, v => v, 12000);
const C1 = JSON.parse(await ev(`JSON.stringify(map.getCenter())`));
ok('F2 camera follows with location on and NO run started | centre ' + JSON.stringify(C1) + ' target lng ' + (base.lng + 0.008), followed === true);
// settle is a STATE, not a moment (Beta 1.28): the Kalman estimate converges asymptotically
// and the glide aims a little ahead while velocity bleeds off, so poll for the settled
// state itself - a single read raced the convergence and flaked at 52-58 px.
let DOT = null;
const dotSettled = await poll120(`(() => { const p = projLL(dispPos); const c = map.getCanvas(); return Math.abs(p.x - c.clientWidth / 2) < c.clientWidth * 0.12 && Math.abs(p.y - c.clientHeight / 2) < c.clientHeight * 0.12; })()`, v => v, 10000);
DOT = JSON.parse(await ev(`(() => { const p = projLL(dispPos); const c = map.getCanvas(); return JSON.stringify({ dx: Math.abs(p.x - c.clientWidth / 2), dy: Math.abs(p.y - c.clientHeight / 2), w: c.clientWidth, h: c.clientHeight }); })()`));
ok('F2 the dot settles kind of in the centre of the screen | dot ' + JSON.stringify(DOT), dotSettled === true && DOT.dx < DOT.w * 0.12 && DOT.dy < DOT.h * 0.12);
await ev(`(() => { watchId = null; return true; })()`);

// Night labels: reload into night mode and read the basemap text paint back.
await ev(`(() => { localStorage.setItem('snow5w.v2.night', '1'); location.reload(); return true; })()`);
await sleep(3000);
ok('F3 night boot with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true && document.body.classList.contains('night')`, v => v, 30000));
const NL = JSON.parse(await ev(`(() => { const out = []; for (const L of map.getStyle().layers) { if (L.type === 'symbol' && L['source-layer'] && L.layout && L.layout['text-field']) out.push({ id: L.id, col: map.getPaintProperty(L.id, 'text-color'), hw: map.getPaintProperty(L.id, 'text-halo-width') }); } return JSON.stringify(out); })()`));
ok('F3 every basemap name layer wears the readable night treatment | layers ' + NL.length + ' ' + JSON.stringify(NL.slice(0, 3)),
  NL.length >= 4 && NL.every(l => l.col === '#ccd6df' && l.hw === 1.3));

R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String(c.text || '').slice(0, 200));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
