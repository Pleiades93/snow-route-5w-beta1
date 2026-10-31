# Changelog

User-facing changes and important reliability fixes. Versions are the
in-app labels (header, under the app name). Since Beta 1.36 the label is
just "Beta X.Y" and the app is called Snow Route Beta.

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
