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


// drive88: v5.53 notes + clean detail battery
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const exc = () => consoleLog.filter(c => c.type === 'EXCEPTION').length;
const rowOf = (n) => `(() => { const rows = [...document.querySelectorAll('.srow')]; const i = names.indexOf('${n}'); return rows[i]; })()`;
await sleep(3000);
await ev(`(() => { localStorage.clear(); location.reload(); return true; })()`); await sleep(3000);
// Phase 1: list buttons + auto-saving notes
await ev(`(() => { $('streetsBtn').click(); return true; })()`); await sleep(400);
let A = JSON.parse(await ev(`(() => JSON.stringify({ rows: document.querySelectorAll('.srow').length, smap: !!document.querySelector('.srow .smap'), snote: !!document.querySelector('.srow .snote') }))()`));
ok('P1 rows carry the pin button and NO note button (v5.55)', A.rows === 34 && A.smap && !A.snote);
await ev(`(() => { ${'PLACEHOLDER'} return true; })()`.replace('PLACEHOLDER', ''));
await ev(`(() => { const r = [...document.querySelectorAll('.srow')][names.indexOf('Velmar')]; r.querySelector('.nwrap').click(); return true; })()`); await sleep(400);
A = JSON.parse(await ev(`(() => JSON.stringify({ ed: !!document.querySelector('.noteEd textarea') }))()`));
ok('P1 name tap opens the note editor', A.ed);
await ev(`(() => { const ta = document.querySelector('.noteEd textarea'); ta.value = 'Driveway at #12 blocked by car'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(800);
A = JSON.parse(await ev(`(() => JSON.stringify({ ls: localStorage.getItem('snow5w.v4.notes') || '', hint: document.querySelector('.noteEd .nhint').textContent, nt: noteTextOf('Velmar') }))()`));
ok('P1 note auto-saves to storage (no Save button)', A.ls.includes('blocked by car') && A.nt.includes('blocked by car'));
ok('P1 editor confirms the save', /Saved/.test(A.hint));
await ev(`(() => { const r = [...document.querySelectorAll('.srow')][names.indexOf('Angie')]; r.querySelector('.nwrap').click(); return true; })()`); await sleep(400);
await ev(`(() => { const ta = document.querySelector('.noteEd textarea'); ta.value = 'Could not clean - gate locked'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(800);
A = JSON.parse(await ev(`(() => JSON.stringify({ nt: noteTextOf('Angie') }))()`));
ok('P1 note works on a street that is not cleaned', A.nt.includes('gate locked'));
await ev(`(() => { location.reload(); return true; })()`); await sleep(3000);
await ev(`(() => { $('streetsBtn').click(); return true; })()`); await sleep(400);
A = JSON.parse(await ev(`(() => { const r = [...document.querySelectorAll('.srow')][names.indexOf('Velmar')]; return JSON.stringify({ preview: r.querySelector('.nt').textContent }); })()`));
ok('P1 note survives reload and previews in the row', A.preview.includes('blocked by car'));
// Phase 2: Reset (finish & save) files the notes with the clean
await ev(`(() => { const base = Date.now() - 3600000;
  runStart = base - 300000; saveStart();
  [['Velmar', 0], ['Mellings', 720000], ['Astona', 1500000]].forEach(([n, off]) => { doneSet.add(n); doneTimes[n] = new Date(base + off).toISOString(); doneVia[n] = 'tap'; });
  refreshAll(); performReset(); return true; })()`); await sleep(400);
A = JSON.parse(await ev(`(() => JSON.stringify({ h: history.length, hn: history[0] ? Object.keys(history[0].notes || {}) : [], live: Object.keys(notes).length, done: doneSet.size }))()`));
ok('P2 clean archived with its notes (cleaned + not-cleaned streets)', A.h === 1 && A.hn.includes('Velmar') && A.hn.includes('Angie'));
ok('P2 live notes cleared for the next clean', A.live === 0 && A.done === 0);
// Phase 3: clean detail screen
await ev(`(() => { openClean(0); return true; })()`); await sleep(400);
A = JSON.parse(await ev(`(() => { const cv = $('cleanView'); const rows = [...cv.querySelectorAll('.cvRow')]; return JSON.stringify({ open: !cv.classList.contains('hidden'), ttl: cv.querySelector('.cvTtl').textContent, meta: cv.querySelector('.cvMeta').textContent, rowNames: rows.map(r => r.querySelector('.cvNm').textContent), firstTm: rows[0] ? rows[0].querySelector('.cvTm').textContent : '', sec: (cv.querySelector('.cvSec') || {}).textContent || '' }); })()`));
ok('P3 detail opens with the clean totals', A.open && /Clean/.test(A.ttl) && /Total time/.test(A.meta));
ok('P3 streets in mark order with per-street times', JSON.stringify(A.rowNames.slice(0, 3)) === JSON.stringify(['Velmar', 'Mellings', 'Astona']) && /took/.test(A.firstTm));
ok('P3 noted-but-not-cleaned group present', /not cleaned/.test(A.sec));
await ev(`(() => { [...$('cleanView').querySelectorAll('.cvRow')][0].click(); return true; })()`); await sleep(300);
A = JSON.parse(await ev(`(() => { const det = $('cleanView').querySelector('.cvDet'); return JSON.stringify({ vis: det.style.display !== 'none', txt: det.textContent }); })()`));
ok('P3 tapping a street expands its details incl. the note', A.vis && /Time taken/.test(A.txt) && /blocked by car/.test(A.txt));
// Phase 4: delete the clean (two-tap)
await ev(`(() => { $('cleanView').querySelector('.cvDel').click(); return true; })()`); await sleep(300);
A = JSON.parse(await ev(`(() => JSON.stringify({ armed: $('cleanView').querySelector('.cvDel').textContent, h: history.length }))()`));
ok('P4 first tap arms the delete', /confirm/.test(A.armed) && A.h === 1);
await ev(`(() => { $('cleanView').querySelector('.cvDel').click(); return true; })()`); await sleep(300);
A = JSON.parse(await ev(`(() => JSON.stringify({ h: history.length, ls: localStorage.getItem('snow5w.v2.history'), cvHidden: $('cleanView').classList.contains('hidden') }))()`));
ok('P4 second tap deletes the clean and persists', A.h === 0 && A.ls === '[]' && A.cvHidden);
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String((c.args && c.args[0]) || c.text || '').slice(0, 220));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
