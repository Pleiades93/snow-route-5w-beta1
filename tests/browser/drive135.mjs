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



// drive135: Beta 1.54 viewport/keyboard hardening (Andrew's deep-dive, 2026-11-01).
// The app now keeps a SETTLED size (fullH) and trusts it over a stuck short report
// in a home-screen install; while typing, the menus ride above the keyboard
// (offsets follow the live report, as they always have - 1.54's pin broke this
// and 1.55 reverted it); and the typing freeze releases only
// after the reported height SETTLES, not the instant a field blurs. The rig
// simulates the keyboard by resizing the emulated screen mid-session (a real
// visualViewport change) and forces display-mode: standalone via emulated media.
// (The screen.height anchor itself cannot be isolated in the rig - emulated
// metrics move screen and viewport together; the phone is its judge. What is
// asserted here is the user-visible machinery: pin, settle-hold, trust, release.)
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
await sleep(3000);
const poll120 = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { const v = await ev(expr); if (v === true) return true; await sleep(300); } return false; };
ok('V0 app boots with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true`));
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 2, mobile: true }, S);
await sleep(400);
ok('V5 (tab mode first, no shim): a short live report rules as-is (820px) - the trust behaviour is home-screen-only', await ev(`document.documentElement.style.getPropertyValue('--vvh')`) === '820px');
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true }, S);
await sleep(300);
// The headless shell cannot emulate display-mode, so the rig shims the media
// query itself before a reload - the app's own detection (matchMedia) and every
// code path after it run for real.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const mm = window.matchMedia.bind(window); window.matchMedia = q => q.indexOf('display-mode') >= 0 ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q); })();` }, S);
await ev(`location.reload()`);
await sleep(2500);
ok('V0b app reboots under the home-screen shim', await poll120(`typeof glOk !== 'undefined' && glOk === true`));
await ev(`syncViewport()`);
ok('V1 settled size learned at boot (900) | ' + await ev(`fullH`), await ev(`fullH`) === 900);
await ev(`$('streetsBtn').click()`); await sleep(500);
await ev(`(() => { const r = [...document.querySelectorAll('.srow')][names.indexOf('Velmar')]; r.querySelector('.nwrap').click(); return true; })()`); await sleep(400);
await ev(`document.querySelector('.noteEd textarea').focus()`);
await sleep(200);
ok('V2a typing state on (kb class)', await ev(`document.body.classList.contains('kb')`));
ok('V2b bottom offset at rest before the keyboard moves (0px) | ' + await ev(`document.documentElement.style.getPropertyValue('--vvb')`), await ev(`document.documentElement.style.getPropertyValue('--vvb')`) === '0px');
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 560, deviceScaleFactor: 2, mobile: true }, S);
await sleep(450);
const pin = JSON.parse(await ev(`JSON.stringify({ vvb: document.documentElement.style.getPropertyValue('--vvb'), vvh: document.documentElement.style.getPropertyValue('--vvh'), dur: getComputedStyle($('sheet')).transitionDuration, sb: $('sheet').getBoundingClientRect().bottom, ih: window.innerHeight })`));
ok('V2c keyboard up: usable height follows the keyboard (560px), sheet frozen, and the sheet sits flush on the LIVE bottom offset (tracks live sizing - no pin) | ' + JSON.stringify(pin), pin.vvh === '560px' && pin.dur === '0s' && Math.abs(pin.sb - (pin.ih - parseFloat(pin.vvb))) <= 1); // Beta 1.55: 1.54 pinned the offsets while typing and hid the note box behind the keyboard on the phone. The rig cannot split window height from visible height the way iOS does, so this asserts the sheet tracks the live variables; the pin's ABSENCE is locked mechanically by the beta-kb-pin-absent registry probe
await ev(`document.querySelector('.noteEd textarea').blur()`);
await sleep(120);
ok('V3a freeze HOLDS just after blur while the height is still short (the 1.31 instant release is gone)', await ev(`document.body.classList.contains('kb')`));
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 750, deviceScaleFactor: 2, mobile: true }, S);
await sleep(180);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true }, S);
ok('V3b once the height is home, the freeze releases and the size is the settled one', await poll120(`!document.body.classList.contains('kb') && document.documentElement.style.getPropertyValue('--vvh') === '900px'`, 2500));
ok('V3c bottom offset still 0px after the whole cycle', await ev(`document.documentElement.style.getPropertyValue('--vvb')`) === '0px');
// W (Beta 1.56): keyboard ownership - with the keyboard UP (height unsettled), a rebuild that destroys the editor must NOT unfreeze the sheet (the pre-1.56 list code removed the class itself, instantly); the single owner holds it, then releases through the settle path once the height is home
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 560, deviceScaleFactor: 2, mobile: true }, S); await sleep(200);
await ev(`(() => { const ta = document.querySelector('.noteEd textarea'); if (ta) ta.focus(); return true; })()`); await sleep(250);
const wBefore = await ev(`document.body.classList.contains('kb')`);
await ev(`(() => { noteOpenFor = null; renderStreets(); return true; })()`);
await sleep(120);
const wHold = await ev(`document.body.classList.contains('kb')`);
ok('W1 editor destroyed by a rebuild mid-typing: the freeze HOLDS while the height is unsettled (owner decides, not the render) | before ' + wBefore + ' hold ' + wHold, wBefore === true && wHold === true);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true }, S);
let wRel = false; for (let i = 0; i < 20 && !wRel; i++) { await sleep(150); wRel = await ev(`!document.body.classList.contains('kb')`); }
ok('W2 once the height is home, the owner releases the freeze (no stuck keyboard state)', wRel === true);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 2, mobile: true }, S);
await sleep(400);
const stuck = JSON.parse(await ev(`JSON.stringify({ vvh: document.documentElement.style.getPropertyValue('--vvh'), vvb: document.documentElement.style.getPropertyValue('--vvb') })`));
ok('V4 stuck-short report (820, no keyboard): the settled 900 is trusted - no strip can paint | ' + JSON.stringify(stuck), stuck.vvh === '900px' && stuck.vvb === '0px');
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true }, S);
await sleep(300);
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION');
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
