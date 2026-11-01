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
  { urlPattern: '*github.io*', requestStage: 'Request' },
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

// drive122 (Beta 1.18): keyboard/viewport regression - see body.
// Every check measures the FAILURE property directly (overflow, overlap, out-of-bounds) in the
// rendered page at phone size, in both themes - never a proxy like a radius or a class name.
const RECTS = (sel) => `(() => [...document.querySelectorAll('${sel}')].filter(e => e.offsetParent !== null).map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }))()`;
const overlaps = (a, b) => a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1;
const inView = (r) => r.x >= -1 && r.y >= -1 && r.r <= 421 && r.b <= 901;
const noOverlap = (rs) => rs.every((a, i) => rs.every((b, j) => i === j || !overlaps(a, b)));
let A;
const poll120 = async (expr, pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { const v = await ev(expr); if (v === true) return true; await sleep(300); } return false; };

ok('K0 app boots with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true`, v => v, 30000));

// ---- K1: the chrome is anchored to the visible screen, not the page ---------
const anchoring = JSON.parse(await ev(`JSON.stringify({
  hud: getComputedStyle($('hud')).position, sheet: getComputedStyle($('sheet')).position,
  modal: getComputedStyle($('noteModal')).position, fan: getComputedStyle($('tabBar')).position })`));
ok('K1 header, sheet, modal and menu button are fixed-anchored | ' + JSON.stringify(anchoring),
  anchoring.hud === 'fixed' && anchoring.sheet === 'fixed' && anchoring.modal === 'fixed' && anchoring.fan === 'fixed');

// ---- K2: both note editors are at the no-auto-zoom text size -----------------
await ev(`(() => { $('streetsBtn').click(); return true; })()`);
await poll120(`$('sheet').classList.contains('open')`, v => v, 5000);
await sleep(500);
await ev(`(() => { const r = document.querySelector('#streetList .srow'); if (r) r.click(); return true; })()`);
await poll120(`!!document.querySelector('.noteEd textarea')`, v => v, 5000);
const fonts = JSON.parse(await ev(`JSON.stringify({
  ed: parseFloat(getComputedStyle(document.querySelector('.noteEd textarea')).fontSize),
  modal: parseFloat(getComputedStyle($('noteText')).fontSize),
  focused: document.activeElement && document.activeElement.tagName })`));
ok('K2 note editors use >=16px text (no iOS focus auto-zoom) and the editor takes focus | ' + JSON.stringify(fonts),
  fonts.ed >= 16 && fonts.modal >= 16 && fonts.focused === 'TEXTAREA');

// ---- K3: keyboard state (Beta 1.61 contract): the layout does NOT chase the
// shrunk visible screen - the published height stays frozen at the full size,
// the bottom offset stays 0, the header keeps the top of the screen, and the
// sheet keeps its pre-keyboard size, flush with the layout bottom (the
// keyboard overlays it). The rig cannot split layout height from visible
// height the way the phone does (layout 932 vs visible 740), so the sheet's
// top is asserted through its unchanged height rather than the stage top:
// on the phone the frozen size is .74 of the FULL height, so its top sits
// on-screen by construction. ----------------------------------------------
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 520, deviceScaleFactor: 2, mobile: true }, S);
await sleep(900);
const shrunk = JSON.parse(await ev(`(() => { const vv = window.visualViewport; const hud = $('hud').getBoundingClientRect(); const sh = $('sheet').getBoundingClientRect();
  const cs = getComputedStyle(document.documentElement);
  return JSON.stringify({ vvH: vv.height, vvT: vv.offsetTop, hudTop: hud.top, hudBottom: hud.bottom, sheetBottom: sh.bottom, sheetTop: sh.top, sheetH: sh.height,
    vvh: cs.getPropertyValue('--vvh'), vvb: cs.getPropertyValue('--vvb'), ih: window.innerHeight }); })()`));
ok('K3 keyboard-state: header unmoved at the top, sheet frozen at its pre-keyboard size and flush with the layout bottom, published height frozen at full | ' + JSON.stringify(shrunk),
  shrunk.hudTop >= shrunk.vvT - 1 && shrunk.hudBottom <= shrunk.vvT + shrunk.vvH + 1 &&
  Math.abs(shrunk.sheetBottom - shrunk.ih) <= 1 && shrunk.sheetH > 600 && shrunk.sheetH <= 668 &&
  shrunk.vvh === '900px' && shrunk.vvb === '0px');

// ---- K4: keyboard closed again - everything settles back (Andrew: "it never
// moves back" - this is the regression for exactly that) -----------------------
await send('Emulation.clearDeviceMetricsOverride', {}, S);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true }, S);
await ev(`(() => { const ta = document.querySelector('.noteEd textarea'); if (ta) ta.blur(); return true; })()`);
await sleep(900);
const restored = JSON.parse(await ev(`(() => { const vv = window.visualViewport; const hud = $('hud').getBoundingClientRect(); const sh = $('sheet').getBoundingClientRect();
  return JSON.stringify({ vvH: vv.height, hudTop: hud.top, sheetBottom: sh.bottom, sy: window.scrollY }); })()`));
ok('K4 restored state: header back at the top, sheet back at the bottom, no leftover page pan | ' + JSON.stringify(restored),
  Math.abs(restored.hudTop) <= 1 && Math.abs(restored.sheetBottom - restored.vvH) <= 2 && restored.sy === 0);

R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String(c.text || '').slice(0, 200));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
