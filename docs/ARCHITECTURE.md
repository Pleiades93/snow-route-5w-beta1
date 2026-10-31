# Architecture

## Overview

Snow Route Beta is a single-page app for one operator clearing driveway
windrows on both sides of a 34-street route in Vaughan, Ontario. It is a
from-scratch MapLibre GL application (no Leaflet): the vector basemap IS the
map, and the tracker's own roads are painted as GeoJSON layers inserted into
the basemap's road stack. There is no server and no account; all state lives
on the device.

The canonical source is assembled, not hand-written as one file. Working
parts live outside the repo in the maintainer's tree and are concatenated
into `src/tracker-source.html` — exactly one inline `<script>` and one
inline `<style>` — then `scripts/build-pages.py` produces the deployed
`index.html` by stamping a Content-Security-Policy (see
`scripts/csp_stamp.py`) and runs `--check` gates (byte parity with the
source, SRI integrity of the two MapLibre CDN files, and the stamped policy
naming all three map hosts). Generated files are never hand-edited.

## Part files (assembly order)

| Part | Responsibility |
|------|----------------|
| `head.html` | Markup and CSS: header bar, sheets, panels, modals, fan, chips, toasts. Design tokens as CSS variables; day/night via `body.night`. |
| `data.js` | Route data only: `ROADS` (OSM-derived centrelines, 34 streets) and the 3 reference features. Verbatim production data. |
| `app1.js` | Core: constants (Metro palette), storage keys and guarded storage, stitch/cut geometry (87 stretches, 174 sides), state, the double-tap guard. |
| `engine.js` | The paint engine (namespace `GLP`): builds GeoJSON families (centres, side bands/edges, selection, labels, route POI) from app state and syncs them to GL sources. Full rebuild + signature cache on state change. |
| `app2.js` | Map boot and interaction: GL map creation, basemap swap + restack, selection, side chips, street panel, list sheet, draggable/flickable sheets, map-failure notice. |
| `app3.js` | Work lifecycle: pace, Start/Finish/Undo, history and Previous cleans, notes, Clear, GPS (smoothing, trail, heading-up camera), coverage suggestions. |
| `app4.js` | System: export/import (report, GPX, backup/restore), preload, update check, fan/night, service-worker registration, boot wiring. |

## The map

- GL JS 4.7.1 from CDN with SRI. Day style: VersaTiles Colorful
  (`tiles.versatiles.org`); night style: CARTO Dark Matter
  (`basemaps.cartocdn.com`, tiles served from `tiles.basemaps.cartocdn.com` —
  all three hosts are in the stamped CSP, gate-verified).
- The basemap keeps ALL of its own labels, restyled to one font/size system
  across both styles (the engine's stack hook); route street names come from
  the app's own label layers (point labels below GL zoom 16.2, line labels
  above; a route POI below the 12.6 pop point). Route paint pops at zoom
  12.6 rather than fading (zero-duration opacity transitions).
- Road colours are the Metro palette: unfinished mains gold `#ffc233`,
  other roads raspberry `#ef476f`, finished mint `#06d6a0`. A marked side is
  a green edge hugging that physical side of the centreline; both sides
  done greens the stretch.
- Failure model: GL `error` events are not fatal. Fatal = `load` not fired
  within 15s, or the style fetch itself failing before first load → the
  map-failure notice shows; marking and all data features keep working.

## Data and persistence

All data is `localStorage` under the serving origin. The key set and the
backup envelope are a contract with production v5.81 — see
`docs/STORAGE-SCHEMA.md` for the full schema, the per-key formats, and the
versioning/migration rules. Restore is transactional (validate → snapshot →
write + verify → verified rollback).

## GPS and coverage

Fixes pass a validity gate (finite, on-Earth), exponential smoothing with
jump/stationary rejection, and a follow camera that rotates heading-up
(course over ground) while a run is active. The trail records only during
a run. Coverage samples each street's centreline every 15m; a fix covers
samples within 22m; at 85% of a street's samples the app SUGGESTS the
street — it never marks it. Confirmation flies to and selects the street;
marking is always manual.

## Offline

`src/sw.js` (deployed as `sw.js`): integrity-checked core (the two MapLibre
files) in the shell cache `snowroute-shell-v1`; navigations network-first
with cache fallback; map styles network-first into the tiles cache
`snowroute-tiles-v1` (cap 3,000); other map resources cache-first.
Activate deletes only `snowroute-` caches (plus the two pre-rename beta cache names, once) — disjoint from production's
`snow5w-` prefix, so the two apps can share an origin safely. An in-app
preload ("Download route maps") warms styles, sprites, glyphs and tiles to
zoom 14 over the route box. Since Beta 1.17 (Stage 2), the first-ever boot
also self-warms: once the worker controls the page, the app fetches both map
styles through it, so the map works offline from the first install —
drive119's first session proves it without any manual reload.

## Testing

CI runs the build gate, the service-worker unit suite, and the
deterministic browser drives on every push to any branch. The drives boot
the real app (file:// with fulfilled map requests; two drives use a local
HTTP origin for true service-worker behaviour, including fully
disconnected restarts). See `docs/TESTING.md` and
`DEVELOPMENT_RULES.md`.
