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



// drive138: Beta 1.59 boot heal. The strip investigation proved iOS picks
// the short stage before first layout and the page cannot reach it - but a
// fresh layout sometimes lands full, so a launch that is still short after
// the settle window reloads ONCE behind the splash and counts the outcome
// (healStats a/r/s). The rig pins screen.height to 900 via a document shim
// while the emulated window plays the short stage (820): boot 1 must heal-
// reload, boot 2 (window restored to 900 by the driver mid-flight) must
// count a recovery and stop; a simulated second launch that stays short
// must count still-short and never loop.
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const poll120 = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { const v = await ev(expr); if (v === true) return true; await sleep(300); } return false; };
await sleep(2500);
ok('B0 app boots for the heal tests', await poll120(`!!window.maplibregl && typeof glOk !== 'undefined'`, 45000));
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { try { const mm = window.matchMedia.bind(window); window.matchMedia = q => q.indexOf('display-mode') >= 0 ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q); } catch (e) {} try { Object.defineProperty(window.screen, 'height', { get: () => 900, configurable: true }); } catch (e) {} try { sessionStorage.setItem('rig.boots', String(parseInt(sessionStorage.getItem('rig.boots') || '0', 10) + 1)); } catch (e) {} })();` }, S);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 2, mobile: true }, S);
await ev(`location.reload()`);
ok('B1 a short launch heal-reloads exactly once | boots', await poll120(`sessionStorage.getItem('rig.boots') === '2'`, 12000));
ok('B1b the attempt is tallied', await poll120(`(JSON.parse(localStorage.getItem('snowroute.v5.heal') || '{}').a || 0) === 1`, 6000));
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true }, S);
await sleep(3000);
ok('B2 a full second layout counts a recovery', await ev(`(JSON.parse(localStorage.getItem('snowroute.v5.heal') || '{}').r || 0) === 1`));
const bootsA = await ev(`sessionStorage.getItem('rig.boots')`);
await sleep(3200);
ok('B3 no heal loop after recovery | boots ' + bootsA, (await ev(`sessionStorage.getItem('rig.boots')`)) === bootsA);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 2, mobile: true }, S);
await ev(`sessionStorage.removeItem('sr.heal'); sessionStorage.removeItem('sr.healN'); location.reload();`);
ok('B4 a still-short second launch stops after one heal | boots', await poll120(`sessionStorage.getItem('rig.boots') === '4'`, 12000));
await sleep(3000);
ok('B4b the still-short outcome is tallied', await ev(`(JSON.parse(localStorage.getItem('snowroute.v5.heal') || '{}').s || 0) === 1 && (JSON.parse(localStorage.getItem('snowroute.v5.heal') || '{}').a || 0) === 2`));
const bootsB = await ev(`sessionStorage.getItem('rig.boots')`);
await sleep(3200);
ok('B5 no heal loop when the stage stays short | boots ' + bootsB, (await ev(`sessionStorage.getItem('rig.boots')`)) === bootsB);
await ev(`(() => { for (let i = 0; i < 5; i++) $('ver').click(); return true; })()`); await sleep(700);
const diag = await ev(`$('diag').textContent`);
ok('B6 diagnostic readout carries the heal tally | ' + diag, typeof diag === 'string' && diag.indexOf('heal ') >= 0);
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION');
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
