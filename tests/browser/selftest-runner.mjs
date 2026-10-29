// Self-test for tests/browser/run.mjs (audit finding T-01, 2026-10-28).
// Writes throwaway fixture drives, runs the real runner against each one,
// and asserts the runner's verdict (its process exit code) is correct for:
//   fixture-ok       passing result block, exit 0          -> runner PASS
//   fixture-lie      passing result block, exit 3          -> runner FAIL
//   fixture-fail     one failed check in the block, exit 0 -> runner FAIL
//   fixture-exc      exceptions in the block, exit 0       -> runner FAIL
//   fixture-noblock  no result block at all, exit 0        -> runner FAIL
//   fixture-hang     never prints, never exits             -> runner FAIL
//                    (killed via RUNNER_TIMEOUT_MS, set short for this test)
// Fixtures are deleted afterwards, pass or fail. No browser is needed:
// the fixtures only print the JSON block the runner parses.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLOCK = (checks, exceptions) => `console.log(JSON.stringify({ checks: ${JSON.stringify(checks)}, exceptions: ${exceptions} }));`;
const FIXTURES = {
  'fixture-ok': BLOCK([['a', true], ['b', true]], 0),
  'fixture-lie': BLOCK([['a', true]], 0) + '\nprocess.exit(3);',
  'fixture-fail': BLOCK([['a', true], ['b', false]], 0),
  'fixture-exc': BLOCK([['a', true]], 2),
  'fixture-noblock': `console.log('just noise, no result block');`,
  'fixture-hang': `setInterval(() => {}, 1000);`,
};
const EXPECT_PASS = { 'fixture-ok': true };

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failures++; };

try {
  for (const [name, src] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(HERE, name + '.mjs'), src + '\n');
  }
  for (const name of Object.keys(FIXTURES)) {
    const env = { ...process.env, RUNNER_TIMEOUT_MS: '2500' };
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(HERE, 'run.mjs'), name], { cwd: HERE, env, encoding: 'utf8', timeout: 60000 });
    const elapsed = Date.now() - t0;
    const wantPass = !!EXPECT_PASS[name];
    check(`${name}: runner exit ${wantPass ? 0 : 1}`, (r.status === 0) === wantPass);
    check(`${name}: runner printed a verdict`, new RegExp(name + ':.*(PASS|FAIL)').test(r.stdout || ''));
    if (name === 'fixture-hang') check('fixture-hang: killed promptly by the runner timeout', elapsed < 30000);
  }
  // One combined run: a single bad drive must fail the whole suite.
  const all = spawnSync(process.execPath, [path.join(HERE, 'run.mjs'), ...Object.keys(FIXTURES)], { cwd: HERE, env: { ...process.env, RUNNER_TIMEOUT_MS: '2500' }, encoding: 'utf8', timeout: 120000 });
  check('combined run: exit 1 when any drive fails', all.status === 1);
  check('combined run: summary line reports FAIL', /BROWSER TESTS: FAIL/.test(all.stdout || ''));
} finally {
  for (const name of Object.keys(FIXTURES)) {
    try { fs.unlinkSync(path.join(HERE, name + '.mjs')); } catch {}
  }
}
console.log(failures === 0 ? 'RUNNER SELF-TEST: PASS' : `RUNNER SELF-TEST: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
