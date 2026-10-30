# Snow Route 5W Beta 1 — Audit Remediation Report

Date: 2026-10-29. Scope: the Beta 1 rebuild only (repo `snow-route-5w-beta1`).
Production (`snow-route-5w-tracker`, v5.81) was not modified at any point.
Method: every claim in the remediation specification was verified against the live beta source
before any fix; no defect is reported fixed without its regression test passing in CI.
Final battery (CI run 40984853964, head 2b62889): **152/152 checks, 12/12 drives PASS, 0 exceptions**,
plus the build gate and the 14-case service-worker unit suite.

## 1. Findings summary

| ID | Severity | Kind | Short title |
|----|----------|------|-------------|
| F-1 | High (usability) | Confirmed defect | Undo tap could be silently swallowed by the double-tap guard |
| F-2 | Medium | Confirmed defect | Coverage indexes validated for upper bound only |
| F-3 | Medium | Confirmed defect | A non-array stored completion value crashed the app at boot |
| G-1 | Low | Validation gap (closed) | GPS fixes accepted without a finite/range check |
| G-3 | Low | Validation gap (closed) | Stored side values not range-checked at load |
| G-6 | Low | Confirmed behaviour (documented) | First-ever boot is not worker-controlled; its map fetches cache nothing |
| G-2 | Info | Validation gap (documented) | Restore validates top-level shape per key; nested content is sanitized at load |
| G-4 | Info | Documented behaviour | Multi-key saves are sequential; failures are mitigated, not transactional |
| G-5 | Info | Unverified risk (resolved by test) | Preload counts fetched responses, not cache-confirmed resources |

## 2. Exact source locations

All locations are in the assembled app script's part files under `beta1/work/newapp/`
(the repo's `src/tracker-source.html` is generated from them).

- F-1: `app3.js` reset-button handler (line ~193-198) with `app1.js` `tapGuard` (400ms per control).
- F-2: `app3.js` line 313 (coverage load filter; code tag "audit D1").
- F-3: `app1.js` line 103 (doneSet load; code tag "audit D2").
- G-1: `app3.js` line 373 (`acceptFix` entry; code tag "audit G1").
- G-3: `app1.js` line 145 (`loadSides`; code tag "audit G3").
- G-6: `src/sw.js` registration timing + `app4.js` boot (service worker registration).
- Verified-healthy areas: `app4.js` line 71 `restoreBackup`; `app3.js` line 236 `finishRun`,
  line 257 `doUndo`, line 404 `coverFix`; `app1.js` line 161 `saveAll`; `src/sw.js` fetch routing.

## 3. Confirmed defects vs validation gaps vs unverified risks

- **Confirmed defects**: F-1 (reproduced repeatedly in CI with state dumps and a step trace),
  F-2 and F-3 (proven from code; F-2's exploit path exercised by regression test),
  G-6 (proven by the offline drive: the style reached the cache only after a controlled reload).
- **Validation gaps**: G-1, G-3 (closed with guards), G-2 (documented; see §8).
- **Unverified risks**: G-5 — preload's counter measures fetch success, not cache residence.
  Offline readiness after a preload is therefore asserted only for the boot path the offline
  drive exercises (style + shell), not for every warmed tile.

## 4. Root causes

- F-1: the reset button's tap handler consulted the 400ms double-tap guard BEFORE the Undo branch.
  A Finish → Yes → Undo sequence can reach the Undo tap inside that window (fast user, fast device),
  and the tap was discarded as a double-tap. The Undo snapshot was left in place but unreachable.
- F-2: the coverage load filter tested only `i < SAMPLES[n].length`. Negative, fractional and
  string indexes survived and each inflated the Set size measured against the 85% suggestion
  threshold. Impact was bounded: the suggestion still requires manual confirmation.
- F-3: `new Set(parseJ(...))` throws a TypeError when the stored JSON value is not iterable
  (a legacy object, number or boolean), aborting the whole script at boot.
- G-1: `acceptFix` passed coordinates straight into smoothing, trail recording and coverage
  math with no finiteness or range check.
- G-3: `loadSides` accepted any values in a right-length array; bitwise side reads counted a
  crafted value (e.g. 99) as marked sides while `streetComplete` (exact 3) disagreed.
- G-6: a service worker cannot control the page load during which it registers, so the first
  boot's map requests bypass it entirely and are never cached.

## 5. Smallest safe fixes applied (all in Beta 1.16; no behaviour redesign)

- F-1: the Undo branch is evaluated before the guard in the reset-button handler. `doUndo`
  clears the snapshot, so the branch cannot double-fire; the pop-up branch keeps its guard.
- F-2: the filter is now `Number.isInteger(i) && i >= 0 && i < SAMPLES[n].length`. The same code
  path serves ordinary load and post-restore reload, so both routes share the rule.
- F-3: the load is guarded with `Array.isArray` plus a real-street string filter; `loadSides`
  re-derives the set from pieces immediately after regardless.
- G-1: one guard line at `acceptFix` entry rejects non-finite or off-Earth coordinates.
- G-3: stored side values are normalized to the 0-3 range the app itself writes.

## 6. Tests added

- **drive118** (19 checks): invalid coverage indexes; invalid GPS coordinates; coverage
  suggestion behaviour (partial coverage suggests nothing; completing a street's samples
  suggests it and marks nothing); parallel-street coverage isolation; restore write failure
  with verified rollback; unverifiable rollback reported honestly; invalid nested history;
  current-format backup round-trip; failed history write at Finish; partial multi-key save
  reload consistency.
- **drive119** (11 checks): true disconnected operation across browser restarts — online boot
  and worker control, style cached, one side seeded; offline relaunch boots from cache with
  progress visible; the street is completed offline and stored; a second offline restart
  keeps the offline-made mark.
- **drive89** hardened: step-trace instrumentation and effect-based waits throughout the
  Finish/Undo/delete flows (see §8 for why).
- Existing coverage reused: drive86 (legacy migration, trail-write honesty, snapshot-failure
  abort), drive114 (migration), drive117 (service-worker upgrade lifecycle), sw.test.mjs (14).

## 7. Regression results — the specification's 15 items

1. Current-format round-trip — drive118 ✓
2. Legacy backup migration — drive86 + drive114 ✓
3. Invalid nested history — drive118 ✓
4. Invalid coverage indexes — drive118 ✓
5. Failed restore write — drive118 ✓
6. Failed rollback verification — drive118 ✓
7. Invalid GPS coordinates — drive118 ✓
8. Parallel-street coverage — drive118 ✓
9. Incomplete route coverage — drive118 ✓
10. Finish followed by Undo — drive89 ✓
11. Failed history persistence — drive118 ✓
12. Partial multi-key storage failure — drive118 ✓
13. Offline startup — drive119 ✓
14. Offline route marking — drive119 ✓
15. Interrupted service-worker update — drive117 ✓

Full battery at report time: 152/152 (CI run 40984853964).

## 8. Unresolved issues and limitations (all documented, none hidden)

- G-2: restore pre-write validation is per-key top-level shape; nested entries are sanitized
  by the loaders on the post-restore reload rather than rejected before writing. Every loader
  was verified (history, trail, notes full; coverage per F-2; sides per G-3) and no malformed
  nested value was found that survives load into use — but a future nested format change must
  re-run this analysis.
- G-4: `saveAll` writes keys sequentially without a transaction. Mitigations verified: the
  Finish path gates its history write BEFORE clearing anything; the completion set is
  re-derived from pieces at load; trail/coverage flushing tracks dirty flags honestly.
- G-5: preload counts successful requests, not cache-confirmed resources (see §3).
- G-6: the map needs one online load under worker control (or the in-app "Download route
  maps" preload) before it can load offline. The shell and all saved progress work offline
  from the first install. A first-run automatic warm-up is a product decision, not taken here.
- Test-battery note: drive89's Finish/Undo chain flaked intermittently across the remediation
  rounds with three distinct signatures, all traced to test sequencing racing the app's real
  400ms double-tap guards (proven by an in-page step trace: `guard:finYes=false`). The checks
  now wait for each tap's observable effect. One genuine app defect was found by this work —
  F-1 — and fixed in the app; the rest were test artifacts, and no human can tap inside 400ms.
- GPS thresholds (15m sampling / 22m radius / 85%) were not changed: no reproducible-test
  evidence justified a change, per the specification's constraint.

## 9. Files changed

- App (Beta 1.16, commit df94586): `app1.js`, `app3.js` (assembled into `src/tracker-source.html`
  and the built `index.html`) — the five fixes in §5, each carrying an in-code audit comment.
- Tests: `tests/browser/drive118.mjs` (new), `tests/browser/drive119.mjs` (new),
  `tests/browser/drive89.mjs` (hardening), `tests/browser/run.mjs` (registration).
- Docs: this report; the working register `AUDIT-REGISTER.md` (working files, not shipped).

## 10. Production-compatibility confirmation

Re-verified at report time, unchanged from before the remediation:
- Storage keys identical to production (the 11 backup keys, including the retained unused
  `snow5w.v5.flip` key kept for format compatibility).
- Backup format `{app:'snow5w-backup', v:1, at, data}` unchanged; missing-key policy preserved
  (absent keys leave current values untouched); legacy done-set migration preserved.
- Restore remains transactional: snapshot, per-key write + re-read verification, verified
  rollback, honest failure messages.
- Finish archives only at 3+ streets; the sub-3 behaviour is unchanged. The Undo window
  remains 8 seconds (Andrew's decision, 2026-10-29).
- GPS suggestions never mark: confirmation flies to and selects the street only.
- Service-worker cache prefixes remain disjoint between production (`snow5w-`) and beta
  (`snow5wbeta1-`); neither app's cleanup can delete the other's caches (string-verified).
- Production itself was never modified: its repository head remains b7de38b / app 641da54.
