# Deployment

## How GitHub Pages serves the app

Pages publishes the **root of the `main` branch**. `index.html` and `sw.js`
must stay at the root: the service worker's scope is the root and the app
registers it by relative path. `src/`, `scripts/`, `tests/` and `docs/` are
ordinary folders (Pages serves them too — the source is public by design).

## Build

```
python3 scripts/build-pages.py
```

Reads `src/tracker-source.html` + `src/sw.js`, writes `index.html` +
`sw.js` at the root, and runs the parity and integrity checks. Never
hand-edit `index.html` or the root `sw.js`.

## Release flow

1. Edit `src/tracker-source.html` (and `src/sw.js` when the worker
   changes). Bump the version label (`#ver`, under the title) — and, if the
   worker changed, its cache name (`snowroute-shell-vN`).
2. Run the build and the tests (`docs/TESTING.md`), plus the release
   regression drives.
3. Test the source build where it will be used; confirm it is good.
4. Commit source, worker and generated files together in one commit and
   push. CI re-runs the build check and the service worker tests.
5. Pages picks the files up within a few minutes; GitHub's edge cache can
   lag ~10 minutes behind the push.

## Updating the installed app

Open the app → ⚙ fan → **Update app** (the ⟳ icon). It fetches the served
page without cache, compares its version label with the running one, and
reloads into the new build, confirming "Updated to vX.Y ✓". If it reports
you are up to date but the label under "Snow Route" shows an older version,
the edge cache has not caught up yet — wait a few minutes and retry.

## Rollback

Revert the release commit, or re-push the previous release's files. Every
release's generated files are reproducible from its own `src/` with the
build script, and the previous release is always reachable in history.

## Verifying a deployment

The label under "Snow Route" shows the running build's version — compare it
with the release you intended to ship.
