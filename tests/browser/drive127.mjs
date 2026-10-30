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



// drive127: Beta 1.28 GPS smoothness (Andrew: the dot jitters and jagged-steps at slow
// speed). The Kalman position filter must keep a noisy stationary dot still, walk a
// slow drift inside a tight corridor with no teleports or reversals, and still track
// real driving speed without lag. Every check measures the displayed path itself.
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const J = async (expr) => { const raw = await ev(`(() => { try { return JSON.stringify((${expr})); } catch (e) { return JSON.stringify({ __err: String(e && e.message || e) }); } })()`); return typeof raw === 'string' ? JSON.parse(raw) : {}; };
await sleep(3000);
ok('F0 app boots with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true`, v => v, 30000));

// deterministic pseudo-noise (metres, [east, north]) - fixed table, no RNG, so a CI
// failure reproduces exactly. First entry is (0,0): the filter initialises on truth.
const NOISE = [[0,0],[5,-3],[-6,2],[3,6],[-2,-6],[7,1],[-5,-4],[1,7],[-7,-1],[4,-5],[-3,3],[6,5],[-1,-7],[2,2],[-4,6],[5,-2]];
const base = JSON.parse(await ev(`(() => { const part = STRETCH.Velmar.parts[0]; const mid = part[Math.floor(part.length / 2)]; return JSON.stringify({ lat: mid[0], lng: mid[1] }); })()`));
const M = (e, n) => [base.lat + n / 111320, base.lng + e / 80386];
await ev(`(() => { watchId = 4242; followPaused = false; window.__rec = []; window.__recT = setInterval(() => { if (dispPos) window.__rec.push([dispPos[0], dispPos[1]]); }, 100); return true; })()`);
const feedAll = async (fixes, gapMs) => ev(`new Promise(res => { const F = ${JSON.stringify(fixes)}; let i = 0; const h = setInterval(() => { const f = F[i]; acceptFix({ coords: { latitude: f[0], longitude: f[1], accuracy: f[2], speed: f[3], heading: 90 }, timestamp: Date.now() }); i++; if (i >= F.length) { clearInterval(h); res(true); } }, ${gapMs}); })`);
const recLen = async () => ev(`window.__rec.length`);
const hav = (a, b) => Math.hypot((b[0]-a[0]) * 111320, (b[1]-a[1]) * 80386); // flat-earth at route latitude (MLNG is already the local value)

// ---- S1: stationary under noise - the dot must stay put ----
const s1fixes = NOISE.map(([e, n]) => { const ll = M(e, n); return [ll[0], ll[1], 12, 0]; });
const s1start = await recLen();
await feedAll(s1fixes, 300); await sleep(1800);
const s1 = JSON.parse(await ev(`JSON.stringify(window.__rec.slice(${s1start}))`));
const P = [base.lat, base.lng];
let s1max = 0, s1path = 0;
for (let i = 0; i < s1.length; i++) { s1max = Math.max(s1max, hav(P, s1[i])); if (i) s1path += hav(s1[i-1], s1[i]); }
ok('S1 a stationary dot under +-7 m fix noise stays within 3 m of truth | max ' + s1max.toFixed(2) + ' m over ' + s1.length + ' samples', s1max < 3);
ok('S1 the displayed path barely moves while stationary (no wander-walk) | path ' + s1path.toFixed(2) + ' m', s1path < 25);

// ---- S2: slow drift 1.2 m/s east under noise - tight corridor, no steps, no reversals ----
const s2fixes = [];
for (let i = 0; i < 40; i++) { const [ne, nn] = NOISE[i % NOISE.length]; const ll = M(i * 0.36 + ne * 0.7, nn * 0.7); s2fixes.push([ll[0], ll[1], 10, 1.2]); }
const s2start = await recLen();
await feedAll(s2fixes, 300); await sleep(1200);
const s2 = JSON.parse(await ev(`JSON.stringify(window.__rec.slice(${s2start}))`));
let s2lat = 0, s2step = 0, s2back = 0, s2maxE = -1e9;
for (let i = 0; i < s2.length; i++) {
  const e = (s2[i][1] - base.lng) * 80386, n = Math.abs((s2[i][0] - base.lat) * 111320);
  s2lat = Math.max(s2lat, n);
  if (i) { s2step = Math.max(s2step, hav(s2[i-1], s2[i])); if (e < s2maxE) s2back = Math.max(s2back, s2maxE - e); }
  s2maxE = Math.max(s2maxE, e);
}
const s2end = JSON.parse(await ev(`JSON.stringify(gpsPos)`));
const s2err = hav(M(14.04, 0), s2end);
ok('S2 slow drift stays in a 4 m corridor | max lateral ' + s2lat.toFixed(2) + ' m', s2lat < 4);
ok('S2 no teleports: max 100 ms step under 2.5 m | max ' + s2step.toFixed(2) + ' m', s2step < 2.5);
ok('S2 no jagged reversals: never backs up more than 1.5 m | max backtrack ' + s2back.toFixed(2) + ' m', s2back < 1.5);
ok('S2 the estimate still arrives: within 5 m of the true endpoint after 14 m at 1.2 m/s | err ' + s2err.toFixed(2) + ' m', s2err < 5);

// ---- S3: real driving speed - the filter must not lag ----
const s3fixes = [];
for (let i = 0; i < 20; i++) { const ll = M(14.04 + i * 2.4, 0); s3fixes.push([ll[0], ll[1], 8, 8]); }
await feedAll(s3fixes, 300); await sleep(800);
const s3end = JSON.parse(await ev(`JSON.stringify(gpsPos)`));
const s3err = hav(M(14.04 + 19 * 2.4, 0), s3end);
ok('S3 at 8 m/s the estimate tracks within 8 m of truth (no over-smoothing lag) | err ' + s3err.toFixed(2) + ' m', s3err < 8);
await ev(`(() => { clearInterval(window.__recT); watchId = null; return true; })()`);

R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String(c.text || '').slice(0, 200));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
