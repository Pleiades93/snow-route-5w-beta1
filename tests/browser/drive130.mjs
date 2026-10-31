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



// drive130: Beta 1.40 label handover (Andrew): zoomed out, OUR titles name the route
// streets; zooming in, they fade out across 15.4-16.4 while the basemap's own road names
// fade in on route streets (clone layers) across the same band; day basemap road names
// are restyled dark for readability; our old line-following labels are retired; the
// West link reference line no longer draws. The L4 rendered-feature check is the one
// that would have caught the Beta 1.33-era clash, where the exclusion filter was
// silently rejected and basemap names printed on route streets at every zoom.
const R = { checks: [] };
const ok = (name, cond) => R.checks.push([name, !!cond]);
const ev = async (code) => evaluate(code);
const poll120 = async (expr, pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { const v = await ev(expr); if (v === true) return true; await sleep(300); } return false; };
ok('L0 app boots with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true`, v => v, 30000));

const S1 = JSON.parse(await ev(`(() => {
  const pt = map.getLayer('streetnamespt4');
  return JSON.stringify({
    streetnamesGone: !map.getLayer('streetnames'),
    ptOpacity: pt ? JSON.stringify(map.getPaintProperty('streetnamespt4', 'text-opacity')) : '',
    ptMax: pt ? pt.maxzoom : null,
    cloneMaj: !!map.getLayer('roads_labels_major-route'),
    cloneMin: !!map.getLayer('roads_labels_minor-route'),
    cloneOpacity: map.getLayer('roads_labels_major-route') ? JSON.stringify(map.getPaintProperty('roads_labels_major-route', 'text-opacity')) : '',
    cloneFilter: map.getLayer('roads_labels_minor-route') ? JSON.stringify(map.getFilter('roads_labels_minor-route')) : '',
    origFilter: JSON.stringify(map.getFilter('roads_labels_major')),
    dayColor: String(map.getPaintProperty('roads_labels_major', 'text-color')),
    dayHalo: String(map.getPaintProperty('roads_labels_minor', 'text-halo-width')),
    refFeatures: map.getSource('ref') ? map.querySourceFeatures('ref').length : -1
  });
})()`));
ok('L1 our line-following streetnames layer is retired | streetnamesGone ' + S1.streetnamesGone, S1.streetnamesGone === true);
ok('L2 our titles fade out across the 15.4-16.4 handover band | opacity ' + S1.ptOpacity + ' maxzoom ' + S1.ptMax,
  S1.ptOpacity.includes('15.4') && S1.ptOpacity.includes('16.4') && S1.ptMax === 16.4);
ok('L3 route-name clone layers exist with the fade-in ramp | clones ' + S1.cloneMaj + '/' + S1.cloneMin + ' opacity ' + S1.cloneOpacity,
  S1.cloneMaj && S1.cloneMin && S1.cloneOpacity.includes('interpolate') && S1.cloneOpacity.includes('15.4'));
ok('L4 originals exclude route names by a valid combined filter | orig ' + S1.origFilter.slice(0, 60) + ' clone ' + S1.cloneFilter.slice(0, 60),
  S1.origFilter.startsWith('["all"') && S1.origFilter.includes('Velmar Drive') && S1.cloneFilter.includes('Velmar Drive'));
ok('L5 day road names wear the readable restyle | color ' + S1.dayColor + ' halo ' + S1.dayHalo, S1.dayColor === '#333333' && S1.dayHalo === '1.5');
ok('L6 the reference source draws nothing (West link off the map) | ref features ' + S1.refFeatures, S1.refFeatures === 0);

// The rendered proof at close zoom: on Malden/Cartwright the basemap names arrive on the
// CLONE layers only - the originals must return none of them (no doubling, ever).
await ev(`(() => { map.jumpTo({ center: [-79.5622, 43.8197], zoom: 17.5 }); return true; })()`);
const settled = await poll120(`(() => { const c = map.queryRenderedFeatures({ layers: ['roads_labels_major-route', 'roads_labels_minor-route'] }).map(f => f.properties.name); return c.includes('Malden Street') && c.includes('Cartwright Boulevard'); })()`, v => v, 25000);
const S2 = JSON.parse(await ev(`(() => JSON.stringify({
  clone: map.queryRenderedFeatures({ layers: ['roads_labels_major-route', 'roads_labels_minor-route'] }).map(f => f.properties.name),
  orig: map.queryRenderedFeatures({ layers: ['roads_labels_major', 'roads_labels_minor'] }).map(f => f.properties.name)
}))()`));
ok('L7 at close zoom the basemap names print on the clones only | clone ' + JSON.stringify(S2.clone) + ' orig ' + JSON.stringify(S2.orig),
  settled === true && S2.clone.includes('Malden Street') && S2.clone.includes('Cartwright Boulevard') && !S2.orig.includes('Malden Street') && !S2.orig.includes('Cartwright Boulevard'));

// Night: the clones are rebuilt per restack and wear the night lift.
await ev(`(() => { localStorage.setItem('snowroute.v2.night', '1'); location.reload(); return true; })()`);
await sleep(3000);
ok('L8 night boot with the map active', await poll120(`typeof glOk !== 'undefined' && glOk === true && document.body.classList.contains('night')`, v => v, 30000));
const S3 = JSON.parse(await ev(`(() => JSON.stringify({
  clone: !!map.getLayer('roads_labels_major-route'),
  col: map.getLayer('roads_labels_major-route') ? String(map.getPaintProperty('roads_labels_major-route', 'text-color')) : ''
}))()`));
ok('L9 night clones rebuilt with the lifted name colour | clone ' + S3.clone + ' color ' + S3.col, S3.clone === true && S3.col === '#ccd6df');

R.exceptions = consoleLog.filter(c => c.type === 'EXCEPTION').map(c => String(c.text || '').slice(0, 200));
console.log(JSON.stringify(R, null, 1));
proc.kill('SIGKILL'); process.exit(0);
