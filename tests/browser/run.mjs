// Runs the deterministic browser drives in tests/browser/ and aggregates
// their results. Each drive boots the app in headless Chromium (via the
// Chrome DevTools Protocol, Node built-ins only), prints a JSON block
//   { checks: [[name, passed], ...], exceptions: <count> }
// as its final output. The verdict is computed here and requires ALL of:
// a parseable result block, every check passed, zero page exceptions, and
// the child exiting with code 0. A drive that prints a passing block and
// then terminates abnormally FAILS (audit finding T-01, 2026-10-28), and a
// drive that never finishes is killed at the timeout and FAILS.
// tests/browser/selftest-runner.mjs proves each of these verdicts.
//
// Usage:
//   node tests/browser/run.mjs              # all drives
//   node tests/browser/run.mjs drive83      # one drive
// Browser binary: CHROME_BIN env var, else /opt/meta-chromium/chrome when
// present, else google-chrome from PATH (the drives apply the same rule).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALL = ['drive65', 'drive66', 'drive83', 'drive86', 'drive88', 'drive89', 'drive114', 'drive115', 'drive116', 'drive117', 'drive118', 'drive119', 'drive120', 'drive121'];
const names = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const TIMEOUT_MS = Number(process.env.RUNNER_TIMEOUT_MS) || 300000;

function runOne(name) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(HERE, name + '.mjs')], { cwd: HERE, env: process.env });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, TIMEOUT_MS);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => { clearTimeout(timer); resolve({ name, code, out, err, timedOut }); });
  });
}

function parseResults(out) {
  const t = out.trim();
  const i = t.lastIndexOf('\n{');
  const start = i >= 0 ? i + 1 : (t.startsWith('{') ? 0 : -1);
  if (start < 0) return null;
  try { return JSON.parse(t.slice(start)); } catch { return null; }
}

let allPass = true;
for (const name of names) {
  const r = await runOne(name);
  if (r.timedOut) {
    console.log(`${name}: FAIL - timed out after ${TIMEOUT_MS}ms and was killed`);
    allPass = false;
    continue;
  }
  const R = parseResults(r.out);
  if (!R || !Array.isArray(R.checks)) {
    console.log(`${name}: FAIL - no result block (exit ${r.code})` + (r.err ? `\n  stderr: ${r.err.slice(0, 300)}` : ''));
    allPass = false;
    continue;
  }
  const failed = R.checks.filter(c => !c[1]);
  const exc = Array.isArray(R.exceptions) ? R.exceptions.length : (R.exceptions ?? 0);
  const pass = r.code === 0 && failed.length === 0 && exc === 0;
  if (!pass) allPass = false;
  console.log(`${name}: ${R.checks.length - failed.length}/${R.checks.length} checks, ${exc} exceptions - ${pass ? 'PASS' : 'FAIL'}` + (r.code !== 0 ? ` (child exit ${r.code})` : ''));
  for (const [n] of failed) console.log(`  FAILED: ${n}`);
  if (Array.isArray(R.exceptions)) for (const x of R.exceptions) console.log(`  EXC: ${x}`);
}
console.log(allPass ? 'BROWSER TESTS: PASS' : 'BROWSER TESTS: FAIL');
process.exit(allPass ? 0 : 1);
