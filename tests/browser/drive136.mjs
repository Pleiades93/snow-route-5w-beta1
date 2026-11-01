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



// drive136: Beta 1.57 Phase 2 storage integrity (external audit Section 7).
// saveAll() has a failure CONTRACT (the authority sides record is written
// first, every write is checked, the first failure is named in saveFailKey);
// Finish and Undo are verified transactions whose gated writes land before
// any state changes. Failures are INJECTED by stubbing
// Storage.prototype.setItem for one key at a time - lsSet converts the throw
// into the false return the contract consumes, which is the failure signal a
// real quota error produces. Each case asserts the user-visible outcome:
// honest toast, run intact, storage coherent.
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
await sleep(3000);
const poll120 = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { const v = await ev(expr); if (v === true) return true; await sleep(300); } return false; };
ok('S0 app boots for the storage transaction tests', await poll120(`!!window.maplibregl && !!document.querySelector('#map canvas')`, 45000));
const INSTALL_STUB = `(() => { window.__stubKey = null; const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (window.__stubKey && k === window.__stubKey) throw new Error('injected quota failure'); return orig.call(this, k, v); }; window.__stub = k => { window.__stubKey = k; }; window.__unstub = () => { window.__stubKey = null; }; return typeof window.__stub === 'function'; })()`;
ok('S0b fault-injection stub installed', await ev(INSTALL_STUB) === true);
const seed = async () => { await ev(`(() => { markDone('Velmar', 'test'); markDone('Mellings', 'test'); markDone('Astona', 'test'); return doneSet.size; })()`); await sleep(250); };
const state = async () => JSON.parse(await ev(`JSON.stringify({ done: doneSet.size, label: $('resetBtn').textContent, toast: $('toast').textContent, hist: history.length, lsHist: JSON.parse(localStorage.getItem('snowroute.v2.history') || '[]').length, fk: saveFailKey, snap: !!undoSnap })`));
await seed();
let st = await state();
ok('S1 seeded clean: 3 streets done, nothing archived yet | ' + JSON.stringify(st), st.done === 3 && st.hist === 0 && st.lsHist === 0);
// F3: the ARCHIVE write fails during Finish - the pre-1.57 gate already
// stopped this; regression-pin it inside the transaction suite.
await ev(`__stub('snowroute.v2.history')`);
await ev(`(() => { performReset(); return true; })()`); await sleep(300);
st = await state();
ok('F3 archive write fails: finish stops, run intact, nothing archived | ' + JSON.stringify(st), st.done === 3 && st.lsHist === 0 && st.label === 'Finish' && /finish stopped/.test(st.toast));
await ev(`__unstub()`);
// F2: the cleared AUTHORITY write fails during Finish - the archive write
// lands first and must be ROLLED BACK; the clean survives whole.
await ev(`__stub('snowroute.v5.sides')`);
await ev(`(() => { performReset(); return true; })()`); await sleep(300);
st = await state();
const sidesKept = JSON.parse(await ev(`(() => { const s = JSON.parse(localStorage.getItem('snowroute.v5.sides') || '{}'); return JSON.stringify({ velmar: (s.p && s.p.Velmar) ? s.p.Velmar.some(v => v > 0) : false }); })()`));
ok('F2 authority write fails: finish stops, archive rolled back, run intact, stored sides untouched | ' + JSON.stringify(st) + ' ' + JSON.stringify(sidesKept), st.done === 3 && st.lsHist === 0 && st.label === 'Finish' && /clean is intact/.test(st.toast) && sidesKept.velmar === true);
await ev(`__unstub()`);
// F1: a MARK whose authority write fails reports the failure (contract +
// episode warning) and does not persist on reload.
await ev(`__stub('snowroute.v5.sides')`);
await ev(`(() => { togglePiece('Boddy', 0, 0); return true; })()`); await sleep(300);
st = await state();
ok('F1 mark with failing authority write: failure named (sides) + storage warning shown | ' + JSON.stringify(st), st.fk === 'sides' && /not saving/.test(st.toast));
await ev(`__unstub()`);
await send('Page.navigate', { url: 'file://' + DIR + '/' + PAGE }, S);
await sleep(3000);
await ev(INSTALL_STUB); // the reload wiped the page-side injection - reinstall it for F4/F5 (the F4/F5 failures in the first local run traced to exactly this, not to the app)
ok('F1b after reload the failed mark is absent and the seeded clean survives whole', await poll120(`doneSet.size === 3 && !streetComplete('Boddy')`, 30000));
// F4: a METADATA write (notes) fails during Finish - the finish completes
// (authority + archive agree) and says so honestly.
await ev(`__stub('snowroute.v4.notes')`);
await ev(`(() => { performReset(); return true; })()`); await sleep(300);
st = await state();
ok('F4 notes write fails: finish completes, archive landed, warning names the gap | ' + JSON.stringify(st), st.done === 0 && st.lsHist === 1 && st.label === 'Undo' && st.fk === 'notes' && /could not be written/.test(st.toast));
await ev(`__unstub()`);
// F5: the AUTHORITY write fails during Undo - the undo stays on offer
// (snapshot retained), then succeeds once storage recovers.
await ev(`__stub('snowroute.v5.sides')`);
await ev(`(() => { doUndo(); return true; })()`); await sleep(300);
st = await state();
ok('F5 authority write fails during undo: undo stopped and STILL on offer, board untouched | ' + JSON.stringify(st), st.done === 0 && st.snap === true && st.label === 'Undo' && /undo stopped/.test(st.toast) && st.lsHist === 1);
await ev(`__unstub()`);
await ev(`(() => { doUndo(); return true; })()`); await sleep(300);
st = await state();
ok('F5b undo succeeds after storage recovers: run restored, archive un-happened | ' + JSON.stringify(st), st.done === 3 && st.lsHist === 0 && st.label === 'Finish' && /Finish undone/.test(st.toast));
// F6 (Beta 1.63, audit F02): the ROLLBACK write itself fails - the archive
// write lands, the authority write fails, and rolling the archive back
// fails too. The stored history and the stored board now disagree, and
// the app must SAY so (never 'your clean is intact'). Needs a sequenced
// stub: the first history write passes, every later one throws, and the
// sides write always throws.
await ev(`(() => { const orig = Storage.prototype.setItem; let histWrites = 0; Storage.prototype.setItem = function (k, v) { if (k === 'snowroute.v5.sides') throw new Error('injected quota failure'); if (k === 'snowroute.v2.history') { histWrites++; if (histWrites > 1) throw new Error('injected quota failure'); } return orig.call(this, k, v); }; window.__seqOrig = orig; return true; })()`);
await ev(`(() => { performReset(); return true; })()`); await sleep(300);
st = await state();
ok('F6 rollback write fails: finish stops, run intact in memory, the divergence is REPORTED (archive persisted, no intact claim) | ' + JSON.stringify(st), st.done === 3 && st.lsHist === 1 && /could not be undone/.test(st.toast) && !/clean is intact/.test(st.toast));
await ev(`(() => { Storage.prototype.setItem = window.__seqOrig; return true; })()`);
await send('Page.navigate', { url: 'file://' + DIR + '/' + PAGE }, S);
ok('F6b after reload the app boots on the diverged store without crashing (the archive is simply there)', await poll120(`typeof doneSet !== 'undefined'`, 30000));
// F7 (Beta 1.63, audit F03): a failing removeItem must surface through
// saveStart() - the delete path reports like every other write.
await ev(`(() => { const orig = Storage.prototype.removeItem; Storage.prototype.removeItem = function (k) { throw new Error('injected delete failure'); }; window.__delOrig = orig; return true; })()`);
const delFail = await ev(`(() => { runStart = 0; return saveStart(); })()`);
await ev(`(() => { Storage.prototype.removeItem = window.__delOrig; return true; })()`);
const delOk = await ev(`(() => { runStart = 0; return saveStart(); })()`);
ok('F7 removeItem failure: saveStart reports false; healthy storage reports true | fail ' + delFail + ' ok ' + delOk, delFail === false && delOk === true);
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION');
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
