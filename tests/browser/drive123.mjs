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

ok('A0 app boots with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true`, v => v, 30000));

// Menu animation baseline (Andrew, 2026-10-30): ONE duration for every menu;
// opening plays the open curve, closing plays its exact time-flip; staggers
// mirror. These checks pin the contract in computed styles, not appearances.
const TOK = JSON.parse(await ev(`(() => { const cs = getComputedStyle(document.documentElement); return JSON.stringify({
  dur: cs.getPropertyValue('--anim-dur').trim(), open: cs.getPropertyValue('--ease-open').trim(), close: cs.getPropertyValue('--ease-close').trim() }); })()`));
ok('A1 shared tokens exist (280ms; mirrored curve pair) | ' + JSON.stringify(TOK),
  TOK.dur === '280ms' && TOK.open === 'cubic-bezier(.25,.8,.3,1)' && TOK.close === 'cubic-bezier(.7,0,.75,.2)');

const sheetT = async () => JSON.parse(await ev(`(() => { const cs = getComputedStyle($('sheet')); return JSON.stringify({
  dur: cs.transitionDuration.split(',')[0].trim(), fn: (cs.transitionTimingFunction.match(/cubic-bezier\([^)]*\)/) || [''])[0].replace(/\s+/g, ''), props: cs.transitionProperty }); })()`));
const closed = await sheetT();
ok('A2 closed sheet animates on the close curve at the shared duration, height included | ' + JSON.stringify(closed),
  closed.dur === '0.28s' && closed.fn === 'cubic-bezier(0.7,0,0.75,0.2)' && closed.props.includes('transform') && closed.props.includes('height') && closed.props.includes('max-height'));
await ev(`(() => { $('listBtn').click(); return true; })()`);
await poll120(`$('sheet').classList.contains('open')`, v => v, 5000);
const opened = await sheetT();
ok('A2 open sheet animates on the open curve at the same duration | ' + JSON.stringify(opened),
  opened.dur === '0.28s' && opened.fn === 'cubic-bezier(0.25,0.8,0.3,1)');

const fanT = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#fanBtns .fanItem')].map(el => { const cs = getComputedStyle(el); return {
  delay: cs.transitionDelay.split(',')[0].trim(), dur: cs.transitionDuration.split(',')[0].trim(), fn: (cs.transitionTimingFunction.match(/cubic-bezier\([^)]*\)/) || [''])[0].replace(/\s+/g, '') }; }))`));
await ev(`(() => { closeSheets(); return true; })()`);
await sleep(500);
const fanClosed = await fanT();
ok('A3 fan closing: shared duration, close curve, mirrored stagger (far item first) | ' + JSON.stringify(fanClosed),
  fanClosed.length === 5 && fanClosed.every(f => f.dur === '0.28s' && f.fn === 'cubic-bezier(0.7,0,0.75,0.2)') &&
  JSON.stringify(fanClosed.map(f => f.delay)) === '["0s","0.04s","0.08s","0.12s","0.16s"]');
await ev(`(() => { $('gearBtn').click(); return true; })()`);
await poll120(`$('fanBtns').classList.contains('open')`, v => v, 5000);
const fanOpen = await fanT();
ok('A3 fan opening: same duration, open curve, stagger nearest-first | ' + JSON.stringify(fanOpen),
  fanOpen.length === 5 && fanOpen.every(f => f.dur === '0.28s' && f.fn === 'cubic-bezier(0.25,0.8,0.3,1)') &&
  JSON.stringify(fanOpen.map(f => f.delay)) === '["0.16s","0.12s","0.08s","0.04s","0s"]');
await sleep(800);
const fanSettled = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#fanBtns .fanItem')].map(el => parseFloat(getComputedStyle(el).opacity)))`));
ok('A4 fan settles fully visible after opening | ' + JSON.stringify(fanSettled), fanSettled.every(o => o === 1));

R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String(c.text || '').slice(0, 200));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
