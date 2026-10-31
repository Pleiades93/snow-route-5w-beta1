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
const ANCHOR = JSON.parse(await ev(`(() => { const g = $('tabBar').getBoundingClientRect(); const cs = getComputedStyle($('tabBar')); return JSON.stringify({
  pos: cs.position, gx: Math.round(g.x), gw: Math.round(g.width), gb: Math.round(g.bottom), vw: window.innerWidth, vh: window.innerHeight }); })()`));
ok('A0 chrome anchored as designed (tab bar fixed across the bottom, Beta 1.23) | ' + JSON.stringify(ANCHOR),
  ANCHOR.pos === 'fixed' && ANCHOR.gx === 0 && ANCHOR.gw === ANCHOR.vw && ANCHOR.gb === ANCHOR.vh);

ok('A1 shared tokens exist (420ms - Andrew slowed the pace in 1.29, smooth over snappy; mirrored curve pair) | ' + JSON.stringify(TOK),
  TOK.dur === '420ms' && TOK.open === 'cubic-bezier(.22,.9,.28,1)' && TOK.close === 'cubic-bezier(.72,0,.1,.78)');

const sheetT = async () => JSON.parse(await ev(`(() => { const cs = getComputedStyle($('sheet')); return JSON.stringify({
  dur: cs.transitionDuration.split(',')[0].trim(), raw: cs.transitionTimingFunction, props: cs.transitionProperty }); })()`));
const firstFn = (raw) => { const seg = String(raw).split('),')[0]; return (seg.endsWith(')') ? seg : seg + ')').replace(/\s+/g, ''); };
const closed = await sheetT(); closed.fn = firstFn(closed.raw);
ok('A2 closed sheet animates on the close curve at the shared duration, height included | ' + JSON.stringify(closed),
  closed.dur === '0.42s' && closed.fn === 'cubic-bezier(0.72,0,0.1,0.78)' && closed.props.includes('transform') && closed.props.includes('height') && closed.props.includes('max-height'));
await ev(`(() => { $('streetsBtn').click(); return true; })()`);
await poll120(`$('sheet').classList.contains('open')`, v => v, 5000);
const opened = await sheetT(); opened.fn = firstFn(opened.raw);
ok('A2 open sheet animates on the open curve at the same duration | ' + JSON.stringify(opened),
  opened.dur === '0.42s' && opened.fn === 'cubic-bezier(0.22,0.9,0.28,1)');

// A3/A4 (re-aimed Beta 1.23): the fan is gone; its stagger contract retired with it.
// The tab bar is static chrome - always fully visible, no animation delays - while
// the menu animation baseline lives on in the sheets (A1/A2 above).
const tabState = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#tabBar .tabItem')].map(el => { const cs = getComputedStyle(el); return {
  op: parseFloat(cs.opacity), delay: cs.transitionDelay.split(',')[0].trim() }; }))`));
ok('A3 tab bar is static chrome: five actions, fully visible, no stagger | ' + JSON.stringify(tabState),
  tabState.length === 5 && tabState.every(t => t.op === 1 && t.delay === '0s'));

// A5 (Beta 1.30): a close must ANIMATE - the sheet's current height is frozen for the
// slide-down and cleared only after the motion ends; clearing it instantly was the snap.
await ev(`(() => { const sh = $('sheet'); sh.style.height = '500px'; sh.classList.add('open'); return true; })()`);
await sleep(100);
await ev(`closeSheets()`);
const frozenH = await ev(`$('sheet').style.height`);
ok('A5 closing freezes the current height for the slide (no instant snap) | height right after close: ' + JSON.stringify(frozenH), frozenH === '500px');
await sleep(700);
const clearedH = await ev(`$('sheet').style.height`);
ok('A5 the frozen height clears once the close motion has ended | ' + JSON.stringify(clearedH), clearedH === '');

// A6 (Beta 1.31): the close X belongs in the sheet's very corner - top-right, above the title line.
await ev(`(() => { $('sheet').classList.add('open'); return true; })()`); await sleep(500);
const A6 = JSON.parse(await ev(`(() => { const sh = $('sheet').getBoundingClientRect(), cl = $('sheetClose').getBoundingClientRect(), ti = $('sheetTitle').getBoundingClientRect(); return JSON.stringify({ topGap: Math.round(cl.top - sh.top), rightGap: Math.round(sh.right - cl.right), closeTop: Math.round(cl.top), titleMid: Math.round(ti.top + ti.height / 2), pacePos: getComputedStyle($('paceClose')).position }); })()`));
ok('A6 close X pinned to the top-right corner, above the title (both sheets) | ' + JSON.stringify(A6),
  A6.topGap >= 0 && A6.topGap <= 8 && A6.rightGap >= 0 && A6.rightGap <= 10 && A6.closeTop < A6.titleMid && A6.pacePos === 'absolute');
await ev(`closeSheets()`); await sleep(300);

R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String(c.text || '').slice(0, 200));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
