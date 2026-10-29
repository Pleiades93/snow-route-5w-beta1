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


// drive89: v5.54 Finish pop-up + delete/back navigation
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const exc = () => consoleLog.filter(c => c.type === 'EXCEPTION').length;
const pollRead = async (expr, pred, ms = 9000) => {   // state-polling wait: fixed sleeps made T4 fail on a slow CI runner (the 8s undo window could lapse mid-jam); assertions unchanged, only the waiting is state-based. Hardened per audit T-02 (2026-10-28): the sampled value resets every iteration; a read that errors (page mid-reload) or returns a non-string counts as not-ready instead of reusing the previous read; a timeout returns {} (explicit not-ready), never the last sampled state.
  const t0 = Date.now();
  do {
    let v;
    try {
      const raw = await ev(expr);
      if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch { v = undefined; } }
    } catch { v = undefined; }
    if (v !== undefined && pred(v)) return v;
    await sleep(150);
  } while (Date.now() - t0 < ms);
  return {};
};
const mark3 = () => ev(`(() => { const base = Date.now() - 3600000; runStart = base - 300000; saveStart();
  [['Velmar', 0], ['Mellings', 720000], ['Astona', 1500000]].forEach(([n, off]) => { doneSet.add(n); doneTimes[n] = new Date(base + off).toISOString(); doneVia[n] = 'tap'; });
  refreshAll(); return true; })()`);
await sleep(3000);
await ev(`(() => { localStorage.clear(); location.reload(); return true; })()`); await sleep(1200);   // floor wait: let the reload actually begin before polling, so the poll cannot be answered by the pre-reload page
// T1: the button is Finish, and red
let A = await pollRead(`(() => { const b = $('resetBtn'); const cs = getComputedStyle(b); return JSON.stringify({ label: b.textContent, bg: cs.backgroundColor }); })()`, v => v.label === 'Finish');
ok('T1 button says Finish', A.label === 'Finish');
ok('T1 button is red', A.bg === 'rgb(194, 47, 36)');
// T2: pop-up flow - No changes nothing
await ev(`(() => { $('resetBtn').click(); return true; })()`); await sleep(300);
A = JSON.parse(await ev(`(() => JSON.stringify({ vis: !$('finModal').classList.contains('hidden'), msg: $('finMsg').textContent }))()`));
ok('T2 Finish opens the Yes/No pop-up', A.vis && /Nothing is marked/.test(A.msg));
await ev(`(() => { $('finNo').click(); return true; })()`); await sleep(300);
A = JSON.parse(await ev(`(() => JSON.stringify({ vis: !$('finModal').classList.contains('hidden'), h: history.length }))()`));
ok('T2 No closes the pop-up, nothing saved', !A.vis && A.h === 0);
// T3: Yes saves the clean (with its note), button becomes Undo finish
await mark3();
await ev(`(() => { setNoteText('Velmar', 'Blocked driveway at #12'); return true; })()`);
await ev(`(() => { $('resetBtn').click(); return true; })()`); await sleep(300);
A = JSON.parse(await ev(`(() => JSON.stringify({ msg: $('finMsg').textContent }))()`));
ok('T3 pop-up summarises streets + notes', /3 of 34 streets/.test(A.msg) && /notes on 1 street/.test(A.msg));
await ev(`(() => { $('finYes').click(); return true; })()`);
A = await pollRead(`(() => JSON.stringify({ h: history.length, done: doneSet.size, label: $('resetBtn').textContent, hn: history[0] && history[0].notes && history[0].notes.Velmar ? history[0].notes.Velmar[0].text : '' }))()`, v => v.h === 1 && v.done === 0);
ok('T3 Yes archives the clean with its notes', A.h === 1 && A.done === 0 && /Blocked driveway/.test(A.hn));
ok('T3 button offers Undo', A.label === 'Undo');
// T4: Undo restores the run
// Harness note (Beta 1.11 diagnosis): the app's Undo window is a real 8 seconds (production parity). The
// T3-to-T4 gap in this drive can exceed 8s on a slow runner - then the button is honestly back to 'Finish'
// and this click opens the pop-up instead of undoing. Handle that branch explicitly: re-finish to reopen a
// fresh Undo window, then undo. The check itself (history cleared, run restored, toast) is unchanged.
await ev(`(() => { $('resetBtn').click(); return true; })()`); await sleep(400);
A = JSON.parse(await ev(`(() => JSON.stringify({ modal: !$('finModal').classList.contains('hidden'), h: history.length }))()`));
if (A.modal && A.h === 1) {
  await ev(`(() => { $('finYes').click(); return true; })()`); await sleep(300);
  await ev(`(() => { $('resetBtn').click(); return true; })()`);
}
A = await pollRead(`(() => JSON.stringify({ h: history.length, done: doneSet.size, toast: $('toast').textContent }))()`, v => v.h === 0 && v.done === 3);
ok('T4 Undo finish restores the run', A.h === 0 && A.done === 3 && /Finish undone/.test(A.toast));
// T5: finish again, then delete returns to Previous cleans (the bug fix)
await ev(`(() => { $('resetBtn').click(); return true; })()`); await sleep(300);
await ev(`(() => { $('finYes').click(); return true; })()`); await sleep(400);
await ev(`(() => { openPace(); return true; })()`); await sleep(300);
await ev(`(() => { $('histHead').click(); return true; })()`); await sleep(300);
await ev(`(() => { document.querySelector('.histRow').click(); return true; })()`); await sleep(400);
A = JSON.parse(await ev(`(() => JSON.stringify({ cvOpen: !$('cleanView').classList.contains('hidden') }))()`));
ok('T5 clean detail opened from Previous cleans', A.cvOpen);
await ev(`(() => { $('cleanView').querySelector('.cvDel').click(); return true; })()`); await sleep(300);
await ev(`(() => { $('cleanView').querySelector('.cvDel').click(); return true; })()`); await sleep(500);
A = JSON.parse(await ev(`(() => JSON.stringify({ h: history.length, sheetOpen: $('sheet').classList.contains('open'), paceVis: !$('pacePanel').classList.contains('hidden'), cvHidden: $('cleanView').classList.contains('hidden'), histRows: document.querySelectorAll('.histRow').length }))()`));
ok('T5 clean deleted', A.h === 0);
ok('T5 after delete: Previous cleans showing, NOT the Streets list', !A.sheetOpen && A.paceVis && A.cvHidden);
// T6: Back also returns to Previous cleans
await mark3();
await ev(`(() => { performReset(); openClean(0); return true; })()`); await sleep(400);
await ev(`(() => { $('cleanView').querySelector('.cvBack').click(); return true; })()`); await sleep(400);
A = JSON.parse(await ev(`(() => JSON.stringify({ sheetOpen: $('sheet').classList.contains('open'), paceVis: !$('pacePanel').classList.contains('hidden'), histRows: document.querySelectorAll('.histRow').length }))()`));
ok('T6 Back returns to Previous cleans too', !A.sheetOpen && A.paceVis && A.histRows === 1);
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String((c.args && c.args[0]) || c.text || '').slice(0, 220));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
