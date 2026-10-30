# Testing

## Commands (run in CI on every push)

```
python3 scripts/build-pages.py --check   # generated files match source; parity + SRI integrity + CSP stamp
node tests/sw.test.mjs                   # service worker fetch-strategy tests
node tests/browser/run.mjs               # deterministic browser drives (second CI job)
node tests/browser/selftest-runner.mjs   # proves the runner's own verdicts (exit code, timeout)
```

The build check rebuilds `index.html` from `src/tracker-source.html` in
memory and fails if the committed file differs, if parity breaks, if the
service worker's integrity hashes drift from the page tags, or if the
page's stamped Content-Security-Policy (see `scripts/csp_stamp.py`) does
not match a fresh hash computation over the built page's own inline
script and style — a code change can never ship under a stale policy.

The service worker suite runs the worker's `cacheFirst` / `netFirst`
functions in Node with mocked caches and fetch — 14 cases: cache hits,
HTTP 503 with and without a cached copy, network failure, cache-write
failure, shell-vs-style confusion, slow-network responses (awaited, then
cached), tile error handling, and cache-write failures in `netFirst`.

## Browser tests (in this repository, run in CI)

`tests/browser/` holds browser drives ported from the maintainer's local
battery — same filenames, same test bodies; only harness plumbing differs
(browser path, source path). Each drive boots the real app from
`src/tracker-source.html` in headless Chromium (Chrome DevTools Protocol,
Node built-ins only, no added dependencies), exercises it, and prints a
JSON result block; `run.mjs` aggregates the blocks and fails if any check
fails, any page exception occurs, a drive exits with a non-zero code, or a
drive overruns its timeout (300s default, `RUNNER_TIMEOUT_MS` overrides).
`selftest-runner.mjs` feeds the runner fixture drives — including one that
prints a passing block and then exits non-zero, and one that hangs — and
asserts each verdict, so the runner cannot silently go back to trusting
the printed block alone.

Coverage:

- `drive65` — stored-data validators: corrupt completion times and history
  are sanitized on load; good records survive.
- `drive66` — backup/restore: a valid backup restores exactly; unsupported
  versions and corrupt values are rejected; a mid-write storage failure is
  reported and the pre-restore state is kept.
- `drive83` — fault battery: prototype-key and malformed street/note data
  cannot corrupt state; a failed Finish (storage error) aborts honestly;
  a post-restore flush does not clobber restored data; a fully failed
  offline prep does not mark itself done.
- `drive86` — audit regression cases: restore and trail handling under
  malformed and legacy-shaped data.
- `drive88` — per-street notes and the per-clean detail view; the street
  counter respects dismissed suggestions.
- `drive89` — the Finish flow end to end: finish, history navigation, and
  the delete/clear pathways.
- `drive114` — migration regression: a partially completed record in the
  earlier bare sides format (and a street completed the street-level way)
  loads with its state exact, gains no fabricated per-side timestamps,
  keeps the work meter and pace inputs honest, and survives a
  backup/restore round-trip unchanged.
- `drive115` — the map-failure notice (v5.81): with every tile request
  refused, the notice appears, streets and marking keep working, the
  first successful tile clears it, dismissal sticks for the session, and
  the banner's layout is measured in both themes.
- `drive116` — the stamped build under its own Content-Security-Policy:
  the app boots with zero policy violations of its own, while an
  injected inline script and a foreign-host script are both refused.
- `drive117` — the service-worker upgrade lifecycle on a real local
  origin (the long-standing SW-02 gap): the app is served over HTTP from
  a per-run fixture (v1 = the shipped files; v2 = a bumped version label
  and shell cache name; the library CDNs are mirrored locally with
  byte-identical, SRI-verified files), the worker registers, activates
  and controls the page, and the app's own Update flow hands off to v2 —
  new shell cache in, old one deleted, the tiles cache and the marked
  route progress intact. Needs network access to download the two
  library files (verified against the SRI hashes in `src/sw.js`) and
  `openssl` to mint the mirror certificate.
- `drive118` — audit-remediation regression suite (2026-10-29): invalid
  coverage indexes and invalid GPS coordinates are rejected; coverage
  suggestion behaviour (partial coverage suggests nothing; a suggested
  street is never auto-marked; parallel streets do not bleed coverage);
  restore write failure with verified rollback; unverifiable rollback
  reported honestly; invalid nested history sanitized; current-format
  backup round-trip; a failed history write stops Finish with the run
  intact; a partial multi-key save reloads to a consistent state.
- `drive119` — true disconnected operation: online boot under worker
  control with the map style cached and one side seeded; the browser is
  killed and relaunched on the same profile with the network emulated
  OFFLINE — the app boots from its own caches, seeded progress is visible,
  the street is completed offline and persisted, and a second offline
  restart keeps the offline-made mark. Same local-origin fixture family
  as `drive117`.

Running locally:

```
node tests/browser/run.mjs            # all drives
node tests/browser/run.mjs drive83    # a single drive
```

The browser binary is chosen by the `CHROME_BIN` environment variable
when set (CI sets it by locating the runner's Chrome); otherwise the
maintainer's local Chromium is used when present, else `google-chrome`
from PATH. The drives fulfil the page's remote map/library requests
through Node fetch, so a run needs network access for those fetches; the
assertions themselves are all local app logic. In the file:// drives the
service worker file is deliberately 404'd to keep runs hermetic — worker
behaviour is covered by `tests/sw.test.mjs` and, end to end on a real
origin, by `drive117` and `drive119`.

## Local-only tests (not in CI)

The rest of the maintainer's drive battery runs locally on every release
but is intentionally not in CI:

- Animation and geometry drives — settings-fan geometry and measured icon
  spacing, fan open/close animation profiles, the Pace/List motion
  comparison, header layout in every state. These assert pixel positions
  and mid-animation states; they are timing-sensitive and would be flaky
  in CI, so they stay local until a deterministic CI strategy exists.
- The SRI regression drive, which verifies the page refuses tampered
  library copies served from the live CDNs (network-dependent; the static
  hash-parity half of that guarantee is in the build check).
- GPS/coverage drives and the remaining historical regression drives.

CI therefore does **not** cover animation or fine geometry; those are
verified locally per release and, for layout, on device. GPS and coverage
LOGIC (fix validation, suggestion thresholds, parallel-street isolation)
is covered in CI by `drive118`; real-world GPS reception on the route
remains a device-only verification.

## Honest limitations

- The service-worker upgrade lifecycle is covered by `drive117` on a
  local origin in headless Chromium. The same handoff on the real
  Pages origin has **not** been run automatically — there it still
  rests on the versioned-cache design and on-device checks after
  each release.
- iOS installed-app behaviour (home-screen install, the standalone top
  band, update flow) is verified on a real device; no emulator covers it.
