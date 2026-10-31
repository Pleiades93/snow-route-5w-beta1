# Changelog

User-facing changes and important reliability fixes. Versions are the
in-app labels (header, under the app name). Since Beta 1.36 the label is
just "Beta X.Y" and the app is called Snow Route Beta.

## Beta 1.42 — 2026-10-31

START-UP SPLASH (Andrew approved the design from the mockups): opening the app cold now starts on the icon blue with the snowflake icon rising in and "Snow Route" sliding in from the right; the pair hold while the map loads behind them, then the flake rushes at you until its white covers the whole screen and dissolves into the app. The exit waits for the map to be genuinely ready (with a safety release so a dead connection can never trap you behind it), and afterwards the splash is removed entirely — it plays once per cold open and never replays. iPhone still launch images (the frozen frame the phone shows before the app loads) ship for current screen sizes, in the same blue with the same icon, so the still and the animation read as one moment.

## Beta 1.41 — 2026-10-31

PERFORMANCE ROUND (Andrew approved, from the 2026-10-31 performance audit — all five levers, each small and reversible):

- Map constructor: `fadeDuration` 0 → 200, so tiles melt in together instead of snapping in one by one; `pixelRatio` capped at 2 (the phone was rendering all 106 layers at its native ratio 3 — 2.25× the pixels; SDF labels stay crisp); `maxTileCacheSize` 200 and `maxTileCacheZoomLevels` 6, so a zoom sweep and the trip back stay parsed instead of re-drawing.
- Offline preload adds z15 over the route core (15 tiles): display zooms 15–19 all render from z15 tiles, which were never preloaded — the working band was the least cached. drive123 A8 now expects 630 tiles / 894 files.
- Theme-flip diet: `glHideLabels` and `tunePlaceLabels` skip style mutations whose value already matches (the pass runs on every stack build — boot, flips, every marking tap — and each redundant mutation re-triggers symbol placement in the workers); the other theme's sprites pre-warm at boot through the service worker; sprite JSON in the worker is now stale-while-revalidate instead of a 3.5 s network race.
- New drive131 pins the constructor values so none of this silently regresses.

## Beta 1.40 — 2026-10-31
Street names now hand over as you zoom. Zoomed out, the app's own titles
name your streets; as you zoom in they fade out while the map's own road
names fade in along the roads — one set at a time, never doubled. The day
map's road names are darker with a firmer edge, so they stay readable
over the coloured route streets instead of washing out. Also gone: the
dashed guide line that traced over Velmar toward Rutherford — no
reference lines draw on the map anymore.

## Beta 1.39 — 2026-10-31
One official green in the selection pop-up: "Mark completed" now uses
the "Mark both sides" green, so both buttons match exactly.

## Beta 1.38 — 2026-10-31
The rename goes all the way down: the app's internal storage names, its
offline-map storage, and the backup file's ID stamp now use the Snow
Route name too, so the app is fully separate from the old app's storage
(they silently shared it before). Nothing visible changes. Saved data
under the old names is not carried over — there was none to carry (no
cleans recorded, no backups made yet) — and the old offline-map storage
is cleaned off the device on first update; offline maps just need one
fresh download.

## Beta 1.37 — 2026-10-31
The rename reaches everything else: the map's route label, the install
description, and this repo's own docs now say Snow Route, and the GitHub
repo itself is renamed to snow-route-beta (the old link redirects to the
new one). The pre-beta v5-era entries that used to fill this file moved
to docs/archive/CHANGELOG-v5-era.md, kept as history.

## Beta 1.36 — 2026-10-31
The app is renamed: Snow Route Beta in the header, the page title, and
the home-screen/install names (it was "Route 5W Beta" before). The
version label drops its old prefix — it now reads just "Beta 1.36" and
counts up from there until version 1.0. Saved progress, backups, and
offline maps are untouched.

## Beta 1.0–1.35
The earlier beta rounds are recorded in this repo's git log (one merge
per round, each verified by the full test battery on the exact commit).
