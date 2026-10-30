# Development Rules — Snow Route 5W Beta → Version 1.0

These rules govern every change to this repository. They exist so the app evolves
incrementally: preserve what works, prove that changes work, protect user data, and
turn every discovered bug into a permanent regression test.

## 1. The change process (every change, no exceptions)

1. **Define the goal** — one sentence: what changes and why.
2. **Inspect dependencies** — read the code and tests the change touches; check what
   else uses the same functions, storage keys, or contracts before editing anything.
3. **Assess risks** — name which existing features, data structures, or workflows
   could be affected, and what the rollback is.
4. **Branch** — work happens on a feature branch created from `main`
   (`github.py ref create-branch <name>`). Never commit feature work directly to
   `main`. `main` is the known-good line.
5. **Implement the smallest appropriate change** — no unrelated refactoring in the
   same change. Visual changes must not alter backend behaviour; backend changes
   must not unexpectedly alter the interface.
6. **Test** — run the applicable automated tests (see §3). A test counts as passed
   only if it was actually executed and its result observed.
7. **Review the diff** — re-read the complete diff before merging; check for
   accidental edits, stale text, and claims the code does not enforce.
8. **Document** — update the docs the change makes stale, in the same change.
9. **Merge only when safe** — the branch's full CI battery must be green
   (`github.py ref merge <branch>`). Then confirm `main`'s battery is green too.

## 2. Per-change report (required with every merge)

- What changed and why.
- Which existing features or data structures could be affected.
- Tests executed and their actual results (counts, not adjectives).
- Any known limitations or remaining risks.
- How to roll back the change if necessary.

## 3. The regression gate

CI (`.github/workflows/checks.yml`) runs on every push to any branch:
`build-pages.py --check` (parity + integrity + CSP), the service-worker unit suite,
and the deterministic browser drives (`tests/browser/run.mjs`).

- A change merges only with a green battery.
- **Never weaken or delete a test assertion to obtain a pass.** When a test fails,
  establish whether the defect is in the app or in the test (state dumps, step
  traces, reproduction), fix the defective side, and say which it was. The
  drive89 history (docs/AUDIT-REMEDIATION-REPORT.md §8) is the worked example:
  one genuine app defect (F-1) and several test-sequencing artifacts, each proven
  before being fixed.
- Every bug fixed gets a regression test that fails without the fix, added in the
  same change whenever the test surface allows it.
- The critical-scenario benchmark is the drive battery itself; new critical
  workflows join it as they are discovered.

## 4. Data protection and backward compatibility

- Storage keys and the backup envelope (`{app:'snow5w-backup', v:1, at, data}`) are
  a contract with production v5.81 and with every existing beta install. Changing
  any key, shape, or the missing-key policy requires: a documented schema note,
  an explicit migration, migration tests (synthetic AND captured-data), and
  Andrew's approval — it is never a drive-by edit.
- Restore stays transactional: validate → snapshot → write + verify → verified
  rollback → honest failure reporting. Do not weaken any step.
- GPS suggestions never mark a street; manual confirmation is a product invariant.
- Coverage thresholds (15m sampling / 22m radius / 85%) change only with
  reproducible-test evidence, never on a hunch.
- Production (`snow-route-5w-tracker`) is never modified as part of beta work.

## 5. Releases and rollback

- Known-good states are tagged (`baseline-*`, `v1.0.0`, …) so any state can be
  restored exactly. Rollback = push the tagged tree to `main` (or re-point Pages)
  and re-run the battery.
- Version identity (cache names, title, `#ver` label) changes only in a release
  change, never inside a feature change.
- Version 1.0 readiness requires, together: all critical workflows passing, zero
  open high-severity defects, existing beta data compatible, backup/restoration
  verified, offline behaviour verified under real disconnected conditions, the
  release process documented, and Andrew's explicit acceptance.

## 6. Honesty rules

- Never claim a test passed, a fix works, or a state was verified without the
  tool result that proves it.
- Distinguish confirmed defects, validation gaps, and unverified risks in every
  report; a suspicion is labelled a suspicion.
- If a check cannot be run (environment, access), say so and name what would
  unblock it — do not route around the admission.
