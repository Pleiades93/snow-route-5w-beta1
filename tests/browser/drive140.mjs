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



// drive140: Beta 1.63 (audit F01) - a note draft belongs to its street.
// The Streets renderer carries an open editor's draft across re-renders
// so typing survives them; before 1.63 the draft was restored into
// WHATEVER street's editor rendered next, so one street's note could
// appear in - and be saved to - another street. Cases: same-street
// re-render keeps the draft (the original intent); switching streets
// finalizes the old editor against ITS street and shows the new street
// its OWN note; an unsaved draft never crosses.
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
await sleep(3000);
const poll120 = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 30000)) { const v = await ev(expr); if (v === true) return true; await sleep(300); } return false; };
ok('N0 app boots for the note-draft tests', await poll120(`typeof renderStreets === 'function' && typeof setNoteText === 'function'`, 30000));
await ev(`(() => { setNoteText('Velmar', 'velmar own note'); setNoteText('Mellings', 'mellings own note'); $('streetsBtn').click(); return true; })()`); await sleep(600);
// N4 first (fresh state): same-street re-render keeps an unsaved draft.
await ev(`(() => { noteOpenFor = 'Velmar'; renderStreets(); const ta = document.querySelector('.noteEd textarea'); ta.value = 'unsaved velmar typing'; return true; })()`); await sleep(150);
await ev(`renderStreets()`);
let v = await ev(`document.querySelector('.noteEd textarea') ? document.querySelector('.noteEd textarea').value : null`);
ok('N4 same-street re-render keeps the in-progress draft | ' + v, v === 'unsaved velmar typing');
// N1: switch streets with that draft still unsaved (no input event, so
// no autosave timer is pending - the draft exists only in the editor).
await ev(`(() => { noteOpenFor = 'Mellings'; renderStreets(); return true; })()`); await sleep(200);
v = await ev(`document.querySelector('.noteEd textarea') ? document.querySelector('.noteEd textarea').value : null`);
const velmarSaved = await ev(`noteTextOf('Velmar')`);
ok('N1 switching streets: the new editor shows its OWN note, not the draft | editor ' + JSON.stringify(v), v === 'mellings own note');
ok('N1b the old street draft was finalized against its own street | ' + JSON.stringify(velmarSaved), velmarSaved === 'unsaved velmar typing');
// N2: switch back - Velmar's editor shows Velmar's (now saved) text.
await ev(`(() => { noteOpenFor = 'Velmar'; renderStreets(); return true; })()`); await sleep(200);
v = await ev(`document.querySelector('.noteEd textarea') ? document.querySelector('.noteEd textarea').value : null`);
ok('N2 switching back: Velmar editor shows Velmar text | ' + JSON.stringify(v), v === 'unsaved velmar typing');
// N3: an emptied editor on one street must not blank another's note.
await ev(`(() => { noteOpenFor = 'Mellings'; renderStreets(); const ta = document.querySelector('.noteEd textarea'); ta.value = ''; noteOpenFor = 'Velmar'; renderStreets(); return true; })()`); await sleep(200);
v = await ev(`document.querySelector('.noteEd textarea') ? document.querySelector('.noteEd textarea').value : null`);
const mel = await ev(`noteTextOf('Mellings')`);
ok('N3 emptied Mellings editor: Velmar note untouched, Mellings note cleared by its own editor only | editor ' + JSON.stringify(v) + ' mellings ' + JSON.stringify(mel), v === 'unsaved velmar typing' && mel === '');
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION');
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
