// Ported from the maintainer's local drive battery (same filename); the
// test body differs from the local copy only in longer waits - the repo
// suite runs the VECTOR Pages build, whose GL failure takes seconds
// before the Esri fallback (and its tile errors) engages. Harness
// plumbing: CHROME_BIN env override, repo-relative source path, default
// page. Runner: tests/browser/run.mjs. See docs/TESTING.md.
// drive115 (added 2026-10-28, v5.81): map-failure notice - see body.
// Ported from the maintainer's local drive battery (same filename); the
// test body is unchanged - only harness plumbing differs: CHROME_BIN env
// override for the browser path, repo-relative source path, default page.
// Runner: tests/browser/run.mjs. See docs/TESTING.md.
// drive114 (added 2026-10-28, audit D-01): migration regression for
// partially completed older records - see the body header below.
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

let failTiles = false;   // drive115: when true, GL style-host requests (Versatiles + CARTO) are failed on purpose (total-basemap-outage simulation)
async function handlePaused(p) {
  const url = p.request.url;
  if (failTiles && (url.includes('versatiles.org') || url.includes('cartocdn.com'))) { await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }, S); return; }
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
  { urlPattern: '*versatiles*', requestStage: 'Request' },
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


const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const exc = () => consoleLog.filter(c => c.type === 'EXCEPTION').length;

// drive115: Beta map-failure notice. The header variant in this drive can
// fail every GL style-host request (failTiles flag in handlePaused),
// simulating a total basemap outage: the vector style can never load.
// Asserts the notice appears when no GL load ever lands, that the streets
// list and marking keep working with no map at all (the beta has no raster
// fallback, by design), that recovery auto-hides it, that dismissal sticks for the
// session, and the Design QA layout measurements in both themes.
const waitBoot = async () => { for (let i = 0; i < 25; i++) { try { if (await ev(`!!document.getElementById('ver')`)) return true; } catch (e) {} await sleep(400); } return false; };
const reload = async (ms) => { await ev(`location.reload(); true`); await sleep(500); await waitBoot(); await sleep(ms || 4000); };
const noteVisible = async () => ev(`!document.getElementById('mapNote').classList.contains('hidden')`);
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 12000)) { if (await fn()) return true; await sleep(300); } return false; };
const rects = async () => ev(`(function(){ const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, btm: b.bottom }; }; return { note: r('mapNote'), gear: r('gearBtn'), info: r('info'), vw: window.innerWidth, vh: window.innerHeight }; })()`);
const overlaps = (a, b) => a && b && a.x < b.r && b.x < a.r && a.y < b.btm && b.y < a.btm;

try {
  await ev(`localStorage.clear(); true`);
  // Phase A: total failure from a cold start.
  failTiles = true;
  await reload(4000);
  ok('A1 notice shows when the GL style can never load', await until(noteVisible, 18000));
  ok('A2 notice text explains streets still work', await ev(`/still work/.test(document.querySelector('#mapNote span').textContent)`));
  ok('A3 no GL load recorded', await ev(`glOk === false`));
  ok('A4 streets list still renders with no map (34 rows)', await ev(`document.querySelectorAll('#streetList .srow').length === 34`));
  await ev(`togglePiece('Velmar', 0, 0); true`); await sleep(600);
  ok('A5 marking still works on the dead map', await ev(`pieces.Velmar[0] === 1`));
  let R1 = await rects();
  ok('A6 layout (day): notice fully in viewport', R1.note && R1.note.x >= 0 && R1.note.y >= 0 && R1.note.r <= R1.vw && R1.note.btm <= R1.vh);
  ok('A7 layout (day): notice does not overlap the gear button', !overlaps(R1.note, R1.gear));
  ok('A8 layout (day): dismiss button is a full-size tap target', await ev(`document.getElementById('mapNoteNo').getBoundingClientRect().height >= 44`));

  // Phase C: recovery - tiles come back, notice clears itself (no dismiss).
  failTiles = false;
  await ev(`setBasemap(); true`);
  ok('C1 first successful GL load auto-hides the notice', await until(async () => await ev(`glOk === true`) && !(await noteVisible())));

  // Phase B: failure again after reload; dismissal sticks while still dead.
  failTiles = true;
  await reload(4000);
  ok('B1 notice shows again on a fresh dead boot', await until(noteVisible, 18000));
  await ev(`document.getElementById('mapNoteNo').click(); true`); await sleep(400);
  ok('B2 dismiss hides the notice', !(await noteVisible()));
  await ev(`setBasemap(); true`); await sleep(2500);
  ok('B3 dismissal sticks while the map stays dead', !(await noteVisible()) && await ev(`glOk === false`));

  // Phase D: healthy boot, night theme - notice stays away; forced layout check at night.
  failTiles = false;
  await reload(2500);
  ok('D1 healthy boot: no notice', await until(async () => await ev(`glOk === true`), 20000) && !(await noteVisible()));
  await ev(`document.getElementById('nightBtn').click(); true`);
  ok('D2 night basemap loads, still no notice', await until(async () => await ev(`isNight() === true && glOk === true && !!map.getSource('centres')`), 20000) && !(await noteVisible()));
  failTiles = true;
  await reload(4000);   // night persists across reload (stored), so this boots night-themed on a dead map
  ok('D3 notice appears in night theme', await ev(`isNight() === true`) && await until(noteVisible, 18000));
  let R2 = await rects();
  ok('D4 layout (night): notice fully in viewport', R2.note && R2.note.h > 40 && R2.note.x >= 0 && R2.note.y >= 0 && R2.note.r <= R2.vw && R2.note.btm <= R2.vh);
  ok('D5 layout (night): notice does not overlap the gear button', !overlaps(R2.note, R2.gear));
  await ev(`document.getElementById('mapNoteNo').click(); true`); await sleep(300);
  ok('D6 night dismiss works', !(await noteVisible()));
} catch (e) {
  R.fatal = String(e && e.message || e);
}
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String((c.args && c.args[0]) || c.text || '').slice(0, 220));
console.log(JSON.stringify(R, null, 1));
// Explicit exit: open CDP/Chrome handles otherwise keep the process alive
// after results print (drive113 lesson, 2026-10-28).
process.exit(0);
