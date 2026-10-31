// Ported from the maintainer's local drive battery (same filename); the
// P1 version assertion is generalized (any v5.x label) so the drive does
// not go stale per release, and P4 waits longer for the vector build's
// GL-failure fallback. This header also enables the CDP Log domain: CSP
// violations are reported there, not via the console API. Harness
// plumbing: CHROME_BIN env override, repo-relative source path, default
// page. Runner: tests/browser/run.mjs. See docs/TESTING.md.
// drive116 (added 2026-10-28, CSP): the stamped Pages build under its own
// Content-Security-Policy - see body.
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
  } else if (msg.method === 'Log.entryAdded') {
    consoleLog.push({ type: 'LOG', text: (msg.params.entry && msg.params.entry.text) || '' });
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
await send('Log.enable', {}, S);
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

// drive116: CSP proof for the stamped build (src/csp-test.html). Asserts the
// policy is present, the app fully works under it (boot, tiles, marking,
// backup), NO CSP violations fire for the app's own resources, and the
// policy BITES: an injected inline script and a foreign external script
// are both refused.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const waitBoot = async () => { for (let i = 0; i < 25; i++) { try { if (await ev(`!!document.getElementById('ver')`)) return true; } catch (e) {} await sleep(400); } return false; };
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 12000)) { if (await fn()) return true; await sleep(300); } return false; };
const cspLog = () => consoleLog.filter(c => /Refused to|Content Security Policy|violates the following/i.test(c.text || ''));


// Repo-suite adaptation: the suite boots the unstamped source by default,
// but this drive's subject is the STAMPED page. Stamp a throwaway copy of
// the current source with the repo's own tool (scripts/csp_stamp.py - the
// single source of the policy) and navigate to it; the checks below then
// run against exactly what the Pages build ships. Copy removed at the end.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP_PAGE = path.join(REPO_ROOT, 'src', '.csp-drive116.html');
fs.copyFileSync(path.join(REPO_ROOT, 'src', 'tracker-source.html'), TMP_PAGE);
execFileSync('python3', [path.join(REPO_ROOT, 'scripts', 'csp_stamp.py'), 'apply', TMP_PAGE], { stdio: 'pipe' });
await send('Page.navigate', { url: 'file://' + TMP_PAGE }, S);
await sleep(800);

try {
  await ev(`localStorage.clear(); location.reload(); true`);
  await sleep(500); await waitBoot(); await sleep(2500);
  ok('P1 app boots under its own CSP (version label live)', await ev(`/^Beta \\d+\\.\\d+$/.test(document.getElementById('ver').textContent)`));
  ok('P2 MapLibre GL loaded from the allowlisted CDN', await ev(`typeof window.maplibregl === 'object'`));
  const pol = await ev(`(function(){ const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]'); return m ? m.getAttribute('content') : ''; })()`);
  ok('P3 CSP meta present, default-src none + script hash', /^default-src 'none'/.test(pol) && pol.includes("script-src 'sha384-"));
  ok('P4 GL actually ACTIVE under CSP (canvas + glOk + route source)', await until(async () => await ev(`glOk === true && !!document.querySelector('canvas.maplibregl-canvas') && !!map.getSource('centres')`), 25000));
  ok('P5 zero CSP violations from the app itself', cspLog().length === 0);
  await ev(`togglePiece('Velmar', 0, 0); true`); await sleep(500);
  ok('P6 marking works under CSP', await ev(`pieces.Velmar[0] === 1`));
  ok('P7 backup builds under CSP', await ev(`buildBackup().includes('snowroute-backup')`));
  const before = cspLog().length;
  await ev(`(function(){ const s = document.createElement('script'); s.textContent = 'window.__cspPwn = 1;'; document.head.appendChild(s); return true; })()`);
  await sleep(700);
  ok('P8 injected inline script is REFUSED (never ran)', await ev(`typeof window.__cspPwn === 'undefined'`));
  ok('P9 the refusal was logged as a CSP violation', cspLog().length > before);
  const before2 = cspLog().length;
  await ev(`(function(){ const s = document.createElement('script'); s.src = 'https://example.com/evil.js'; document.head.appendChild(s); return true; })()`);
  await sleep(900);
  ok('P10 foreign external script is REFUSED (violation logged)', cspLog().slice(before2).some(c => /example\.com/.test(c.text)));
  ok('P11 CSP allows every host the Protomaps styles actually use, and the retired hosts are gone (2026-10-29 dark-mode regression)', pol.includes('tiles.basemaps.cartocdn.com') && pol.includes('protomaps.github.io') && !pol.includes('versatiles.org') && !pol.includes('https://basemaps.cartocdn.com'));
} catch (e) {
  R.fatal = String(e && e.message || e);
}
R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String((c.args && c.args[0]) || c.text || '').slice(0, 220));
console.log(JSON.stringify(R, null, 1));
// Explicit exit: open CDP/Chrome handles otherwise keep the process alive.
try { fs.rmSync(TMP_PAGE, { force: true }); } catch (e) {}
process.exit(0);
