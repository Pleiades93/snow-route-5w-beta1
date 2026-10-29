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


// drive66 tail: v5.39 restore suite only (drive65 Phase B fix: recapture backup after reload)
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const toast = async () => await ev(`(() => $('toast').textContent)()`);
await sleep(3200);

await ev(`(() => { markDone('Columbus', 'tap'); saveAll(); saveHistory(); window.__good = buildBackup(); return true; })()`);
await sleep(300);
await ev(`(() => { markDone('Galloway', 'tap'); return true; })()`);
await sleep(300);
await ev(`(() => { $('xText').value = window.__good; doRestore(); return true; })()`);
await sleep(2200);
const B1 = JSON.parse(await ev(`(() => JSON.stringify([...doneSet]))()`));
ok('B1 valid backup restores exactly', JSON.stringify(B1) === '["Columbus"]');

// recapture AFTER the reload wiped window.__good (the drive65 bug)
await ev(`(() => { saveAll(); saveHistory(); window.__good = buildBackup(); markDone('Galloway', 'tap'); return true; })()`);
await sleep(300);

await ev(`(() => { const p = JSON.parse(window.__good); p.v = 99; $('xText').value = JSON.stringify(p); doRestore(); return true; })()`);
await sleep(400);
ok('B2 unsupported version rejected', (await toast()).includes('Unsupported backup version'));
const B2s = JSON.parse(await ev(`(() => JSON.stringify([...doneSet].sort()))()`));
ok('B2 state untouched', JSON.stringify(B2s) === '["Columbus","Galloway"]');

await ev(`(() => { const p = JSON.parse(window.__good); p.data['snow5w.v2.times'] = 'not json'; $('xText').value = JSON.stringify(p); doRestore(); return true; })()`);
await sleep(400);
ok('B3 corrupt value rejected', (await toast()).includes('not valid JSON'));
const B3s = JSON.parse(await ev(`(() => JSON.stringify([...doneSet].sort()))()`));
ok('B3 state untouched', JSON.stringify(B3s) === '["Columbus","Galloway"]');

await ev(`(() => { window.__origSet = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v) { if (k === 'snow5w.v2.history') throw new Error('quota'); return window.__origSet.call(this, k, v); }; $('xText').value = window.__good; doRestore(); return true; })()`);
await sleep(400);
ok('B5 mid-write failure reported', (await toast()).includes('Restore failed'));
const B5s = JSON.parse(await ev(`(() => JSON.stringify([...doneSet].sort()))()`));
ok('B5 rollback keeps pre-restore state', JSON.stringify(B5s) === '["Columbus","Galloway"]');
await ev(`(() => { Storage.prototype.setItem = window.__origSet; return true; })()`);

R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String((c.args && c.args[0]) || c.text || '').slice(0, 220));
ok('no page exceptions', R.exceptions.length === 0);
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL');
process.exit(0);
