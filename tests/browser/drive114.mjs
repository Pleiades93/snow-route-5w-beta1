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

// drive114: D-01 migration regression (2026-10-28 audit) - partially completed
// OLDER records under the current app. Fixture = a v5.77-era device: Velmar
// completed the street-level way (doneSet + doneTimes, NO sides record),
// Woolacott partially done in the v5.77 BARE sides format {street: [bits]}
// with no per-side timestamps anywhere, plus one v5.77-era history entry
// (no sides snapshot). Asserts the audit's list: completion preserved,
// unfinished stays unfinished, progress exact, missing timestamps never
// fabricate history (a complete street inherits ONLY its recorded
// completion instant; a partial street gets no times at all), pace inputs
// stay honest, save/reload is stable, and a backup -> wipe -> restore
// round-trip reproduces the migrated state exactly.
const VTIME = '2026-10-20T11:00:00.000Z';
const waitBoot = async () => { for (let i = 0; i < 25; i++) { try { if (await ev(`!!document.getElementById('ver')`)) return true; } catch (e) {} await sleep(400); } return false; };
const reload = async () => { await ev(`location.reload(); true`); await sleep(500); await waitBoot(); await sleep(3200); };
const setLS = async (k, v) => ev(`localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)}); true`);
const noValidTimes = async (n) => ev(`(function(){ const T = pieceTimes[${JSON.stringify(n)}]; if (!T) return true; const flat = []; T.forEach(pr => { if (Array.isArray(pr)) pr.forEach(x => flat.push(x)); }); return flat.every(x => typeof x !== 'string' || isNaN(Date.parse(x))); })()`);

try {
  await ev(`localStorage.clear(); true`);
  await setLS('snow5w.v2', '["Velmar"]');
  await setLS('snow5w.v2.times', JSON.stringify({ Velmar: VTIME }));
  await setLS('snow5w.v5.sides', JSON.stringify({ Woolacott: [3, 1, 0] }));   // BARE v5.77 format: no {p,t} wrapper, no times
  await setLS('snow5w.v2.history', JSON.stringify([{ at: '2026-10-20T12:30:00.000Z', items: { Velmar: VTIME }, via: 'tap', notes: {}, km: 1.7, startedAt: '2026-10-20T10:45:00.000Z' }]));
  await reload();

  ok('M1 partial pieces preserved exactly', await ev(`JSON.stringify(pieces.Woolacott) === '[3,1,0]'`));
  ok('M2 street-level completion migrated to all pieces done', await ev(`pieces.Velmar.length === 14 && pieces.Velmar.every(v => v === 3)`));
  ok('M2b complete street inherits only its recorded completion instant', await ev(`pieceTimes.Velmar.every(pr => pr[0] === '${VTIME}' && pr[1] === '${VTIME}')`));
  ok('M3 unfinished street stays unfinished (count 1 of 34)', await ev(`!doneSet.has('Woolacott') && doneSet.has('Velmar') && document.getElementById('count').textContent.replace(/\\s+/g, ' ').includes('1 of 34')`));
  ok('M4 partial street has NO fabricated side times', await noValidTimes('Woolacott'));
  ok('M5 work meter equals seed-derived side-metres exactly', await ev(`(function(){ const L = STRETCH.Woolacott.lens; const exp = STRETCH.Velmar.lens.reduce((a, b) => a + 2 * b, 0) + 2 * L[0] + L[1]; return Math.abs(workDoneM() - exp) < 0.01; })()`));
  ok('M6 pace events are exactly the inherited instants, nothing invented', await ev(`(function(){ const e = workEvents(); return e.length === 28 && e.every(ms => ms === Date.parse('${VTIME}')); })()`));
  ok('M6b paceInfo runs safely on migrated data', await ev(`(function(){ try { const P = paceInfo(); return !!P && typeof P === 'object'; } catch (e) { return false; } })()`));
  ok('M7 legacy history entry (no sides snap) loads', await ev(`history.length === 1`));

  // New work on the migrated record: one more side, marked the app's own way.
  await ev(`togglePiece('Woolacott', 2, 0); true`); await sleep(700);
  ok('M8 new side marked on migrated record', await ev(`JSON.stringify(pieces.Woolacott) === '[3,1,1]'`));
  const stamp = await ev(`pieceTimes.Woolacott[2][0]`);
  ok('M8b new side got a real timestamp', typeof stamp === 'string' && !isNaN(Date.parse(stamp)));
  ok('M8c old sides still carry no times', await ev(`(function(){ const T = pieceTimes.Woolacott; const flat = [...T[0], ...T[1]]; return flat.every(x => typeof x !== 'string' || isNaN(Date.parse(x))) && !T[2][1]; })()`));

  await reload();
  ok('M9 save/reload keeps migrated state stable', await ev(`JSON.stringify(pieces.Woolacott) === '[3,1,1]' && doneSet.has('Velmar') && !doneSet.has('Woolacott')`));
  ok('M9b the one real timestamp survives reload unchanged', await ev(`pieceTimes.Woolacott[2][0] === ${JSON.stringify(stamp)}`));

  // Backup -> wipe -> restore round-trip of the migrated state.
  const bak = await ev(`buildBackup()`);
  await ev(`localStorage.clear(); true`); await reload();
  await ev(`(function(){ document.getElementById('xText').value = ${JSON.stringify(bak)}; doRestore(); return true; })()`);
  await sleep(600); await waitBoot(); await sleep(3200);
  ok('M10 round-trip: pieces identical', await ev(`JSON.stringify(pieces.Woolacott) === '[3,1,1]' && pieces.Velmar.every(v => v === 3)`));
  ok('M10b round-trip: completion + times intact', await ev(`doneSet.has('Velmar') && !doneSet.has('Woolacott') && doneTimes.Velmar === '${VTIME}' && pieceTimes.Woolacott[2][0] === ${JSON.stringify(stamp)}`));
  ok('M10c round-trip: still no fabricated times for old sides', await ev(`(function(){ const T = pieceTimes.Woolacott; const flat = [...T[0], ...T[1]]; return flat.every(x => typeof x !== 'string' || isNaN(Date.parse(x))); })()`));
} catch (e) {
  R.fatal = String(e && e.message || e);
}
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String((c.args && c.args[0]) || c.text || '').slice(0, 220));
console.log(JSON.stringify(R, null, 1));
// Explicit exit: open CDP/Chrome handles otherwise keep the process alive
// after results print (drive113 lesson, 2026-10-28).
process.exit(0);
