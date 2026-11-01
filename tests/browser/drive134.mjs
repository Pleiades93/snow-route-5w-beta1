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



// drive134: Beta 1.51 viewport re-measure hardening (Andrew's launch glitch).
// The app measures the visible screen once at startup; iOS can hand a
// home-screen app a too-short height at launch and correct it silently, so
// 1.51 re-measures on pageshow, on return to the front, and on rotation.
// This drive corrupts the measured values on purpose and proves each trigger
// restores them. It also pins the title block's lowered position (Andrew:
// title + version down slightly - 8px more top padding on the header).
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
await sleep(3000);
const poll120 = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { const v = await ev(expr); if (v === true) return true; await sleep(300); } return false; };
ok('W0 app boots with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true`));
const expect = `(() => { const vv = window.visualViewport; const vvb = Math.max(0, window.innerHeight - vv.offsetTop - vv.height) + 'px'; const vvh = vv.height + 'px'; const de = document.documentElement.style; return de.getPropertyValue('--vvb') === vvb && de.getPropertyValue('--vvh') === vvh; })()`;
const corrupt = `(() => { const de = document.documentElement.style; de.setProperty('--vvb', '77px'); de.setProperty('--vvh', '111px'); return de.getPropertyValue('--vvb') === '77px'; })()`;
ok('W1 measured values are sane at boot', await ev(expect));
ok('W2a corruption lands', await ev(corrupt));
await ev(`window.dispatchEvent(new Event('pageshow'))`);
ok('W2 pageshow re-measures and restores the values', await poll120(expect, 8000));
ok('W3a corruption lands again', await ev(corrupt));
await ev(`document.dispatchEvent(new Event('visibilitychange'))`);
ok('W3 return-to-front re-measures and restores the values', await poll120(expect, 8000));
ok('W4a corruption lands a third time', await ev(corrupt));
await ev(`window.dispatchEvent(new Event('orientationchange'))`);
ok('W4 rotation re-measures and restores the values', await poll120(expect, 10000));
ok('W5 title block sits lower (header top padding 15px in the rig, no safe-area inset)', await ev(`getComputedStyle(document.getElementById('hud')).paddingTop === '15px'`));
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String(c.text || '').slice(0, 200));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
