# Snow Route Beta

A single-file web app for tracking driveway snow clearing on Route 5W in Vaughan, Ontario.
Built for one operator working a route of 34 streets: tap a street, tap **Mark completed**,
and the map, pace clock and history stay in step — designed to be used from a phone in a
truck, in the dark, with gloves-adjacent tapping and spotty signal.

## Live

- **GitHub Pages (main host):** https://pleiades93.github.io/snow-route-5w-tracker/

## What it does

- All 34 route streets drawn from real OpenStreetMap centrelines: mains (cleaned
  first) yellow, the rest red, done green. Streets are cut into stretches at
  every junction and each stretch's two physical sides are marked separately —
  the road plow leaves a windrow on both sides, and the two sides are rarely
  cleaned in the same pass. Tap a stretch and use the arrow chips that pop up
  on each side of the road; a cleaned side shows as a green edge line, and
  consecutive finished stretches join into one continuous line. A street
  counts done when every stretch is done on both sides, and the info panel
  still completes a whole street in one tap.
- Pace tracking against your last full clean, GPS coverage suggestions (a street
  that looks covered is *offered*, never auto-marked), a snow log with per-clean
  GPS paths, and full backup / restore.
- Flip mode rotates the whole map 180° for starting from the far end; night mode
  for plowing in the dark. Flip, Night, the location pin, home and the app-update
  check live in the ⚙ settings fan at the **bottom right**.
- Progress is stored **on the device only** (browser local storage). There is no
  server and no account; the backup/restore export is the way to move data.
- Offline: after the first online open, the app quietly saves the route area's
  Esri fallback tiles (day + night) and warms the vector style files, so a
  later cold start with no signal still shows a map under the route. The
  vector tiles themselves are cached as you view them. The one-time prep is
  only marked done when tiles actually saved; a failed prep retries on the
  next open.

## Backup & restore

- A backup is one JSON file holding every storage key the app uses.
- Restore validates the file first — backup version and every value's shape —
  before anything is written; a bad file changes nothing.
- Before writing, restore snapshots the current data. Each restored value is
  verified by reading it back; on any failure the snapshot is put back and that
  rollback is itself verified by reading back. The result message reports what
  actually happened, including if a rollback could not be completed.
- **Missing keys:** a key absent from a backup leaves the current value on the
  device untouched. Restore replaces what the backup contains; it does not
  clear what it does not mention. This is deliberate.
- **Legacy data:** the completion set was once stored as an object map instead
  of a list. Backups in that old format are accepted and converted on import.

## Files

| File | What it is |
|---|---|
| `src/tracker-source.html` | **The canonical application source — the only file where the app itself is edited** (raster basemap mode). Same app, same features as the deployment; see *Build & parity* below. |
| `src/sw.js` | The authored service worker source (offline open + tile caching). Edited here; copied to the root by the build. |
| `index.html` | **Generated** deployable build: vector basemap (OpenFreeMap by day, CARTO dark at night) via MapLibre GL under Leaflet, with automatic fallback to Esri raster tiles if the vector source fails. This is what GitHub Pages serves. Never hand-edit. |
| `sw.js` | **Generated** copy of `src/sw.js`. Must sit beside `index.html` on an https host. Never hand-edit. |
| `scripts/build-pages.py` | The repository-owned build: generates `index.html` + `sw.js` from `src/` and runs the parity and integrity checks. Standard library only. |
| `tests/sw.test.mjs` | Service worker fetch-strategy tests (Node, mocked caches/fetch). |
| `docs/` | `ARCHITECTURE.md`, `TESTING.md`, `DEPLOYMENT.md` — the detailed procedures. |
| `manifest.json` | Home-screen install metadata (name, icons, full-screen launch). |
| `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `icon-maskable-512.png` | App icons for the home screen (Beta 1.35: the Signal Asphalt design — glossy snowflake traced by an asphalt road — at every size; the maskable one is padded so round icon masks do not clip the snowflake or its road trace). |

## Build & parity

`index.html` is **generated** from `src/tracker-source.html` by the build
script in this repository — it is never hand-edited:

```
python3 scripts/build-pages.py           # build + verify (writes index.html, sw.js)
python3 scripts/build-pages.py --check   # verify only: committed files match a fresh build
node tests/sw.test.mjs                   # service worker tests
```

The only intentional differences between source and deployment are the
basemap: `index.html` runs in vector mode with the MapLibre GL library tags
injected; the source runs the raster mode used for testing. On every build
the script reverses those known changes and asserts the result is
byte-identical to the source — so any other difference fails the build.
The build also asserts that the service worker's library integrity hashes
match the page tags exactly, so the two copies of those fingerprints cannot
drift. GitHub Actions runs the `--check` build and the service worker tests
on every push. Parity proves the two files carry identical app logic; it
does not replace functional testing, which is done separately on every
release — see `docs/TESTING.md`. Deployment is `docs/DEPLOYMENT.md`;
architecture is `docs/ARCHITECTURE.md`; changes are in `CHANGELOG.md`.

## Running it

This repo is the main source. GitHub Pages serves `index.html` straight from the
`main` branch — pushing the updated files is the whole deploy. Without `sw.js`
beside it, everything works except the offline open; without `manifest.json`
and the icons, the home-screen install just loses its name and icon.

Map data © OpenStreetMap contributors; vector styles © OpenFreeMap / © CARTO;
fallback imagery-style tiles © Esri.
