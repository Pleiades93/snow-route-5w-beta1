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

ok('V0 app boots with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true`, v => v, 30000));

// V1 (Beta 1.21 layout): the dock - List | round run button | Pace on one level,
// centred and symmetrical; the gear alone at the top left; the header is title-only.
const dockGeom = async () => JSON.parse(await ev(`(() => { const r = (id) => { const b = $(id).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }; };
  return JSON.stringify({ list: r('listBtn'), pace: r('paceBtn'), start: r('startBtn'), gear: r('gearBtn'), vw: window.innerWidth }); })()`));
let D = await dockGeom();
let rects = [D.list, D.pace, D.start];
ok('V1 dock buttons all inside the viewport | dock ' + JSON.stringify(D), rects.every(inView));
ok('V1 dock buttons do not overlap each other', noOverlap(rects));
ok('V1 run button is centred and List/Pace are symmetrical around it | dock ' + JSON.stringify(D),
  Math.abs(D.start.cx - D.vw / 2) <= 2 && Math.abs((D.start.cx - D.list.cx) - (D.pace.cx - D.start.cx)) <= 2 && Math.abs(D.list.cy - D.start.cy) <= 2 && Math.abs(D.pace.cy - D.start.cy) <= 2);
ok('V1 gear sits alone at the top left | gear ' + JSON.stringify(D.gear), D.gear.x >= 8 && D.gear.x < D.vw / 2 && D.gear.y >= 0 && D.gear.y < 120);
A = await J(`({ sw: $('hud').scrollWidth, cw: $('hud').clientWidth })`);
ok('V1 header content does not overflow horizontally', A.sw <= A.cw + 1);

// V2: same with a street selected (selection strip visible - the state whose old
// floating-panel version overflowed the header in the production app's history)
await ev(`(() => { const part = STRETCH.Velmar.parts[0]; const mid = part[Math.floor(part.length / 2)]; map.jumpTo({ center: mid, zoom: 16 }); selectStretch('Velmar', 0, mid); return true; })()`); // a real tap always passes an anchor point; without one the chip layout cannot run
await sleep(700);
rects = JSON.parse(await ev(`JSON.stringify(${RECTS('#hud button')})`));
ok('V2 with selection strip: header buttons inside the viewport', rects.every(inView));
ok('V2 with selection strip: header buttons do not overlap', noOverlap(rects));
D = await dockGeom();
ok('V2 dock stays centred with a street selected | dock ' + JSON.stringify(D), Math.abs(D.start.cx - D.vw / 2) <= 2 && [D.list, D.pace, D.start].every(inView));

// V3: side chips are 40px, in bounds, and do not overlap each other
const chips = JSON.parse(await ev(`JSON.stringify(${RECTS('.sideChip .chipBtn')})`));
ok('V3 two side chips are shown', chips.length === 2);
ok('V3 chips are 40px tap targets', chips.every(c => Math.abs(c.w - 40) <= 2 && Math.abs(c.h - 40) <= 2));
ok('V3 chips inside the viewport and not overlapping | chips ' + JSON.stringify(chips), chips.every(inView) && !overlaps(chips[0], chips[1]));
// V3b: the same selection with the stretch point pushed against the right edge - the
// independent per-chip clamp used to squeeze the pair together there (drive120's catch).
await ev(`(() => { const part = STRETCH.Velmar.parts[0]; const mid = part[Math.floor(part.length / 2)]; map.jumpTo({ center: [mid[0], mid[1] - 0.0035], zoom: 16 }); selectStretch('Velmar', 0, mid); return true; })()`);
await sleep(700);
const chipsEdge = JSON.parse(await ev(`JSON.stringify(${RECTS('.sideChip .chipBtn')})`));
ok('V3b edge-anchored chips keep their separation | chips ' + JSON.stringify(chipsEdge), chipsEdge.length === 2 && chipsEdge.every(inView) && !overlaps(chipsEdge[0], chipsEdge[1]));

// V4: menu fan - five 50px items in a column with clear gaps, all in bounds
await ev(`(() => { deselect(); $('gearBtn').click(); return true; })()`);
await sleep(800);
const fan = JSON.parse(await ev(`JSON.stringify(${RECTS('#fanBtns .fanItem')})`));
ok('V4 fan shows six items', fan.length === 6);
ok('V4 fan items are 50px and inside the viewport | fan ' + JSON.stringify(fan), fan.every(f => Math.abs(f.w - 50) <= 2 && Math.abs(f.h - 50) <= 2 && inView(f)));
const sorted = [...fan].sort((a, b) => a.y - b.y);
ok('V4 fan items have clear vertical gaps (no overlap)', sorted.every((f, i) => i === 0 || sorted[i - 1].b <= f.y - 6));

// V5: sheets - open sheet fits the viewport; closed sheet is truly invisible
await ev(`(() => { closeFan(); $('listBtn').click(); return true; })()`); // the List button toggles the sheet itself; there is no openList() function
await poll120(`$('sheet').classList.contains('open')`, v => v, 5000);
await sleep(600);
A = await J(`(() => { const r = $('sheet').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; })()`);
ok('V5 open list sheet fits the viewport | sheet ' + JSON.stringify(A), inView(A) && A.y >= 0);
await ev(`(() => { closeSheets(); return true; })()`);
await sleep(600);
A = await J(`(() => { const e = $('sheet'); const r = e.getBoundingClientRect(); return { vis: getComputedStyle(e).visibility, top: r.top }; })()`);
ok('V5 closed sheet is invisible (hidden or fully below the viewport)', A.vis === 'hidden' || A.top >= 899);

// V6: night theme - header measurements hold there too
await ev(`(() => { $('gearBtn').click(); return true; })()`);
await sleep(500);
await ev(`(() => { $('nightBtn').click(); return true; })()`);
await sleep(900);
A = await J(`({ night: document.body.classList.contains('night') })`);
D = await dockGeom();
ok('V6 night: dock centred, inside the viewport, no overlaps | dock ' + JSON.stringify(D), A.night === true && [D.list, D.pace, D.start].every(inView) && noOverlap([D.list, D.pace, D.start]) && Math.abs(D.start.cx - D.vw / 2) <= 2);

R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String(c.text || '').slice(0, 200));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
