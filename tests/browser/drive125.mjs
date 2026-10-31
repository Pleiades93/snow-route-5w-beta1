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

ok('S0 app boots with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true`, v => v, 30000));

// Beta 1.22 (Andrew's phone round): one-word green Start; count as "N of 34 - P%";
// a dead strip under the dock so the iPhone home swipe cannot drag the map;
// the header slab is transparent so the map runs full-screen at the top too.
// Beta 1.42: the start-up splash overlays the first seconds by design - hit-test
// probes (elementFromPoint) must wait until it has removed itself, or they measure
// the splash instead of the app. (drive132 owns the splash's own checks.)
await poll120(`!document.getElementById('splash')`, v => v, 20000);
const S22 = JSON.parse(await ev(`(() => { const sb = $('startBtn'); const cs = getComputedStyle(sb);
  const strip = $('tabBar'); const sr = strip.getBoundingClientRect(); const br = sb.getBoundingClientRect();
  const atBottom = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 3);
  const atStart = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
  return JSON.stringify({ label: sb.textContent.trim(), bg: cs.backgroundColor, count: $('count').textContent,
    hudBg: getComputedStyle($('hud')).backgroundColor,
    strip: { x: sr.x, w: sr.width, top: sr.top, bottom: sr.bottom }, startB: br.bottom,
    atBottom: atBottom && (atBottom.id || (atBottom.closest('#tabBar') ? 'tabBar' : '')), atStart: atStart && atStart.id, color: cs.color, vw: window.innerWidth, vh: window.innerHeight }); })()`));
ok('S1 Start button: black circle, volt-yellow word (per the reference) | ' + JSON.stringify(S22), S22.label === 'Start' && S22.bg === 'rgb(10, 10, 11)' && S22.color === 'rgb(216, 255, 61)');
ok('S2 count reads "0 of 34 · 0%" (no "completed") | ' + S22.count, S22.count === '0 of 34 · 0%');
ok('S3 header slab is transparent (map full-screen at the top)', S22.hudBg === 'rgba(0, 0, 0, 0)');
ok('S4 tab bar spans the bottom edge and takes the touch there (the old dead-strip job), dock clear above it | ' + JSON.stringify(S22),
  S22.strip.x === 0 && S22.strip.w === S22.vw && Math.abs(S22.strip.bottom - S22.vh) <= 1 && S22.startB <= S22.strip.top + 1 && S22.atBottom === 'tabBar' && S22.atStart === 'startBtn');

// T (Beta 1.29, Andrew): menus are ONE family - the Streets/Pace sheets, the bottom
// bar and the Settings pop-up share a surface in each theme; day is light glass with
// dark text (never white-on-white over the bright map), night is a deep blue-black.
const T1 = JSON.parse(await ev(`(() => { const surf = el => getComputedStyle(el).backgroundColor; return JSON.stringify({
  sheetBg: surf($('sheet')), sheetCol: getComputedStyle($('sheet')).color, paceBg: surf($('pacePanel')),
  barBg: surf($('tabBar')), menuBg: surf($('setMenu')), fillW: $('countFill').offsetWidth,
  order: [...document.querySelectorAll('#tabBar .tabItem')].map(b => b.id) }); })()`));
ok('T1 day menus share one light surface with dark text (bar = sheets = settings pop-up) | ' + JSON.stringify(T1),
  T1.sheetBg === 'rgba(255, 255, 255, 0.92)' && T1.sheetCol === 'rgb(28, 37, 52)' && T1.paceBg === T1.sheetBg && T1.barBg === T1.sheetBg && T1.menuBg === T1.sheetBg);
ok('T2 tab order: Locate, Night, Home dead centre, Clear, Settings | ' + JSON.stringify(T1.order),
  JSON.stringify(T1.order) === JSON.stringify(['gpsBtn', 'nightBtn', 'homeBtn', 'clearBtn', 'setBtn']));
ok('T3 the meter starts empty | fillW ' + T1.fillW, T1.fillW === 0);
await ev(`(() => { $('setBtn').click(); return true; })()`); await sleep(600);
const T3b = JSON.parse(await ev(`(() => JSON.stringify({ open: $('setMenu').classList.contains('open'),
  rows: [...document.querySelectorAll('#setMenu .setRow')].map(b => ({ id: b.id, lbl: b.querySelector('.tabLbl').textContent, svg: !!b.querySelector('svg') })) }))()`));
ok('T3 Settings rises with Update and Backup inside (Pack D icons + labels) | ' + JSON.stringify(T3b),
  T3b.open === true && T3b.rows.length === 2 && T3b.rows[0].id === 'updBtn' && T3b.rows[1].id === 'exportBtn' && T3b.rows.every(r => r.svg && r.lbl.length > 0));
await ev(`(() => { $('setBtn').click(); return true; })()`); await sleep(600);
ok('T3 Settings closes on a second tap', await ev(`$('setMenu').classList.contains('open')`) === false);

// P1 (Beta 1.33, Protomaps): ONE places system - localities (cities/towns/villages) are
// gated by the tile data itself, size by size (the Apple/Google ladder); the app's tuning
// owns the neighbourhood layer's arrival (9) and the 15.5 cap where route labels take over.
const PL1 = JSON.parse(await ev(`(() => { const byId = {}; for (const L of map.getStyle().layers) byId[L.id] = { mn: L.minzoom, mx: L.maxzoom }; return JSON.stringify({ sub: byId['places_subplace'], loc: byId['places_locality'] }); })()`));
ok('P1 day map: Protomaps place ladder (neighbourhood layer in at 9, places capped at 15.5) | ' + JSON.stringify(PL1),
  !!PL1.sub && PL1.sub.mn === 9 && !!PL1.loc && PL1.loc.mx === 15.5);
// P3: the zooms are only a promise - prove the little places actually RENDER at a wide view.
await ev(`(() => { map.jumpTo({ center: [(routeBox.w + routeBox.e) / 2, (routeBox.s + routeBox.n) / 2], zoom: 10.5 }); return true; })()`);
let placeCount = 0;
for (let i = 0; i < 24 && placeCount < 5; i++) { await sleep(500); placeCount = await ev(`map.queryRenderedFeatures({ layers: ['places_locality', 'places_subplace'] }).filter(f => f.properties && f.properties.name).length`); }
ok('P3 at z10.5 the day map renders named little places, not just permits them | count ' + placeCount, placeCount >= 5);
// P3b (Andrew): zoomed out until the route is a dot, the REGION must still read like a map -
// the surrounding municipalities on the labels, so he can keep his bearings.
await ev(`(() => { map.jumpTo({ center: [(routeBox.w + routeBox.e) / 2, (routeBox.s + routeBox.n) / 2], zoom: 9.2 }); return true; })()`);
let regionNames = [];
for (let i = 0; i < 24; i++) { await sleep(500); regionNames = JSON.parse(await ev(`JSON.stringify(map.queryRenderedFeatures({ layers: ['places_locality'] }).map(f => f.properties && f.properties.name).filter(Boolean))`)); if (['Vaughan', 'Richmond Hill', 'Markham', 'Toronto', 'King City', 'Aurora', 'Newmarket'].filter(n => regionNames.includes(n)).length >= 2) break; }
ok('P3b at dot-zoom (z9.2) the surrounding cities/towns are on the map | ' + JSON.stringify(regionNames.slice(0, 14)),
  ['Vaughan', 'Richmond Hill', 'Markham', 'Toronto', 'King City', 'Aurora', 'Newmarket'].filter(n => regionNames.includes(n)).length >= 2);
await ev(`(() => { $('homeBtn').click(); return true; })()`); await sleep(600);

// S6/S7 (Beta 1.24): after Start, Cancel must float ABOVE the circle - clear of the
// tab bar and tappable; and the chrome icons must compute to bright colours on the
// dark glass (a duplicated dark colour value once rendered them invisible).
await ev(`(() => { $('startBtn').click(); return true; })()`);
await sleep(700);
const S6 = JSON.parse(await ev(`(() => { const c = $('cancelStartBtn'); const cr = c.getBoundingClientRect(); const tr = $('tabBar').getBoundingClientRect();
  const hit = document.elementFromPoint(cr.x + cr.width / 2, cr.y + cr.height / 2);
  return JSON.stringify({ disp: c.style.display, cancel: { y: cr.y, b: cr.bottom }, tabTop: tr.top, hit: hit && hit.id, nightLbl: $('nightBtn').querySelector('.tabLbl').textContent,
    listCol: getComputedStyle($('streetsBtn')).color, paceCol: getComputedStyle($('paceBtn')).color, tabCol: getComputedStyle($('homeBtn')).color }); })()`));
ok('S6 Cancel start floats above the circle, clear of the tab bar, and takes the tap | ' + JSON.stringify(S6),
  S6.disp !== 'none' && S6.cancel.b <= S6.tabTop - 40 && S6.hit === 'cancelStartBtn');
ok('S7 day mode: chrome is light glass with dark icons (GPS-app behaviour) | ' + JSON.stringify(S6),
  S6.listCol === 'rgb(34, 38, 46)' && S6.paceCol === 'rgb(34, 38, 46)' && S6.tabCol === 'rgb(43, 48, 56)');
await ev(`(() => { $('nightBtn').click(); return true; })()`);
await sleep(600);
ok('S7 day mode: the theme tab offers Night - it names where it takes you, not where you are (Beta 1.28) | label ' + S6.nightLbl, S6.nightLbl === 'Night');
const S7 = JSON.parse(await ev(`(() => JSON.stringify({ night: document.body.classList.contains('night'), nightLbl: $('nightBtn').querySelector('.tabLbl').textContent,
  listCol: getComputedStyle($('streetsBtn')).color, tabCol: getComputedStyle($('homeBtn')).color,
  barBg: getComputedStyle($('tabBar')).backgroundColor, countCol: getComputedStyle($('count')).color }))()`));
ok('S7 night mode: chrome flips to dark glass with bright icons | ' + JSON.stringify(S7),
  S7.night === true && S7.listCol === 'rgb(242, 244, 248)' && S7.tabCol === 'rgb(221, 229, 236)' && S7.barBg === 'rgba(7, 10, 17, 0.94)' && S7.countCol === 'rgb(238, 244, 238)');
ok('S7 night mode: the theme tab now offers Day, label and state in agreement | label ' + S7.nightLbl, S7.nightLbl === 'Day');
const T4 = JSON.parse(await ev(`(() => { const surf = el => getComputedStyle(el).backgroundColor; return JSON.stringify({
  sheetBg: surf($('sheet')), sheetCol: getComputedStyle($('sheet')).color, barBg: surf($('tabBar')), menuBg: surf($('setMenu')) }); })()`));
ok('T4 night menus share the deep blue-black (bar = sheets = pop-up), text bright | ' + JSON.stringify(T4),
  T4.sheetBg === 'rgba(7, 10, 17, 0.94)' && T4.sheetCol === 'rgb(237, 242, 249)' && T4.barBg === T4.sheetBg && T4.menuBg === T4.sheetBg);
const PL2 = JSON.parse(await ev(`(() => { const byId = {}; for (const L of map.getStyle().layers) byId[L.id] = { mn: L.minzoom, mx: L.maxzoom }; return JSON.stringify({ sub: byId['places_subplace'], loc: byId['places_locality'] }); })()`));
ok('P2 night map too: same Protomaps ladder (subplace 9, locality capped 15.5) | ' + JSON.stringify(PL2),
  !!PL2.sub && PL2.sub.mn === 9 && !!PL2.loc && PL2.loc.mx === 15.5);
await ev(`(() => { markDone('Woolacott', 'tap'); selectStretch('Woolacott', 0, STRETCH.Woolacott.line[3]); return true; })()`); await sleep(300);
const NAC = await ev(`getComputedStyle($('selPop')).boxShadow`);
ok('P4 the colour edge survives the night theme (mint for the completed Woolacott) | ' + NAC, NAC.includes('6, 214, 160'));
await ev(`(() => { markUndone('Woolacott'); deselect(); return true; })()`);

// P5 (Beta 1.33, Andrew: "make sure nothing breaks when switching and everything stays
// the same"): with a street done, a selection up and the camera moved off home, flip
// night -> day -> night and prove selection, progress, camera, route stack and the tuned
// place zooms survive EVERY swap untouched.
await ev(`(() => { markDone('Woolacott', 'tap'); selectStretch('Woolacott', 0, STRETCH.Woolacott.line[3]); map.jumpTo({ center: [-79.5595, 43.8155], zoom: 14.2 }); return true; })()`); await sleep(500);
const swSnap = async () => JSON.parse(await ev(`(() => { const L = {}; for (const l of map.getStyle().layers) L[l.id] = l; return JSON.stringify({ night: document.body.classList.contains('night'), centre: map.getCenter().toArray(), zoom: map.getZoom(), name: $('selName').textContent, count: $('countTxt').textContent, route: !!map.getLayer('t1-surface'), gps: !!map.getLayer('gps-dot'), sub: L['places_subplace'] ? L['places_subplace'].minzoom : null, locMax: L['places_locality'] ? L['places_locality'].maxzoom : null }); })()`));
const swWait = async () => { for (let i = 0; i < 20; i++) { if (await ev(`!!(window.map && map.getLayer && map.getLayer('t1-surface'))`)) return; await sleep(400); } };
const SW0 = await swSnap();
await ev(`(() => { $('nightBtn').click(); return true; })()`); await swWait(); await sleep(300);
const SW1 = await swSnap();
ok('P5 switching to DAY keeps everything: selection, progress, camera, stack, place tuning | ' + JSON.stringify(SW1),
  SW1.night === false && SW1.name === SW0.name && SW1.count === SW0.count && Math.abs(SW1.centre[0] - SW0.centre[0]) < 0.0001 && Math.abs(SW1.centre[1] - SW0.centre[1]) < 0.0001 && Math.abs(SW1.zoom - SW0.zoom) < 0.01 && SW1.route && SW1.gps && SW1.sub === 9 && SW1.locMax === 15.5);
await ev(`(() => { $('nightBtn').click(); return true; })()`); await swWait(); await sleep(300);
const SW2 = await swSnap();
ok('P5 switching back to NIGHT keeps everything too | ' + JSON.stringify(SW2),
  SW2.night === true && SW2.name === SW0.name && SW2.count === SW0.count && Math.abs(SW2.centre[0] - SW0.centre[0]) < 0.0001 && Math.abs(SW2.centre[1] - SW0.centre[1]) < 0.0001 && Math.abs(SW2.zoom - SW0.zoom) < 0.01 && SW2.route && SW2.gps && SW2.sub === 9 && SW2.locMax === 15.5);
await ev(`(() => { markUndone('Woolacott'); deselect(); return true; })()`);

await ev(`(() => { $('cancelStartBtn').click(); return true; })()`);
await sleep(400);

await ev(`(() => { markDone('Woolacott', 'tap'); return true; })()`);
await sleep(400);
const C2 = await ev(`$('count').textContent`);
ok('S5 count climbs in the new format after a street is done | ' + C2, /^1 of 34 · \d+%$/.test(C2));
await sleep(600);
const T5 = JSON.parse(await ev(`(() => JSON.stringify({ ratio: $('countFill').offsetWidth / $('count').offsetWidth, want: workDoneM() / totalWorkM(), txt: $('countTxt').textContent, count: $('count').textContent }))()`));
ok('T5 the pill meter fills with the same work fraction the % reports | ' + JSON.stringify(T5),
  Math.abs(T5.ratio - T5.want) < 0.04 && T5.want > 0 && T5.txt === T5.count);


R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String(c.text || '').slice(0, 200));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
