# Changelog

User-facing changes and important reliability fixes. Versions are the
in-app labels (header, under the app name). Since Beta 1.36 the label is
just "Beta X.Y" and the app is called Snow Route Beta.

## Beta 1.50 — 2026-10-31

PERFORMANCE TEST ROUND — the outside audit's Groups A and B, built as one removable layer over Beta 1.49. Nothing about how the app looks or behaves is supposed to change; it should just feel lighter: selecting a street no longer re-sends the whole route's data to the map, only the selection; the two side arrows are no longer rebuilt from scratch on every map movement, only when their picture actually changes; the selection's breathing glow pauses while the app isn't on screen instead of repainting twenty times a second into the void; marking a street updates its row in the list instead of rebuilding all 34 rows; the map is only told to resize when its size truly changed; and the offline map download now fetches five files at a time instead of strictly one by one (same 894 files, same honest saved-count), with the behind-the-scenes cache tidying itself in batches instead of after every single tile. If anything feels worse than 1.49, say so — this entire round comes off in one step and 1.49 (with its GPS and beam fixes) stays.

## Beta 1.49 — 2026-10-31

YOUR TWO RULES, BUILT IN. First: location now has two honest modes. The Locate tab by itself only shows you live — where you are and which way you're facing — and never records anything; your route is recorded only while a clean is running, by that clean's own location, exactly as you set it down. You'll always know which mode you're in: the Locate tab wears blue for view-only and red while a clean is recording, and it tells you in words when it starts ("view only, not recording" / "recording your route"). If you tap Locate in the middle of a clean you've started, it resumes that clean's recording and says so — recording always belongs to the clean, never to the tab alone. Second: the direction beam is rebuilt to match the picture you sent — a smooth fan that's strong at the dot and fades with distance, soft at the edges instead of a hard flat wedge, with a softer shadow under a slightly bolder dot.

## Beta 1.48 — 2026-10-31

RELIABILITY ROUND (from an outside audit of Beta 1.44 — every claim was checked against the app before any fix was made). The headline is a test, not the app: the GPS centring test was switching location on through a side door, so the camera helper that runs for real users never ran in the test — the app was fixed for this back in Beta 1.28, the test never got the update, and its random-looking failures were the test's own shadow. The test now starts location the real way, proves it can tell following from not-following, and keeps its original strictness. Real fixes in the app: if your signal goes stale mid-clean and location restarts itself, it now remembers it belongs to your clean; the direction beam no longer lingers after location is turned off; a backup that cannot read a piece of your data now refuses instead of quietly leaving the piece out; a network connection that never answers can no longer hang the app's start when a saved copy exists (slow connections still get their full chance); the background refresh of the map's icon sheets can no longer be cut off mid-update; and your backup file is finally named snowroute-backup.json instead of the retired 5W name — the file itself is unchanged and old backups still restore. One audit claim needed no fix: finishing a clean already refuses to clear your board if the save does not land.

## Beta 1.47 — 2026-10-31

FULL SCREEN, FINISHED (Andrew: other apps cover the whole screen, this one should too). The phone paints a frame around the page in Safari — its top strip and the area behind its bottom bar — in a colour the app chooses. Ours was set to near-black in both modes, so by day a dark band wrapped the light map and the app looked boxed in. The frame colour now follows the app: light by day, dark by night, switching the moment the mode switches. Together with 1.46 (no reserved strip in the Home Screen app), the app now covers the screen edge to edge the way the others do.

## Beta 1.46 — 2026-10-31

SPLASH HANDOFF, SMOOTH (Andrew's report: in the browser it was fine, but as a Home Screen app the icon dropped a step at the very start). The cause was not the splash at all: the app told the phone to keep a black bar across the top, so the frozen first picture filled the whole screen while the app itself started below that bar — everything centred about half an inch lower, and the icon visibly stepped down when the picture handed over. The app now fills the whole screen like a native app (the clock and battery float over it), so the picture and the splash line up exactly — measured within a single pixel. Four newer/larger phone sizes also got their frozen first pictures (the biggest Pro Max screens, the 16 Pro size, the Air, and the mini size).

## Beta 1.45 — 2026-10-31

SPLASH, SIMPLER (Andrew's call after living with it): the icon no longer animates in. The still picture the phone shows first has the icon sitting still — so when the splash took over and the icon vanished and rose again, that little replay felt like a glitch no matter how smoothly it ran. Now the icon sits exactly as it does in the still from the first frame, and the only movement at the start is the "Snow Route" words sliding in. The exit is unchanged: the flake still rushes at you and dissolves into the app.

## Beta 1.44 — 2026-10-31

SPLASH SMOOTHNESS (Andrew: it still glitched and stuttered on the phone). The animation itself never changed after 1.42 — what changed from open to open was how much start-up work landed on top of it: creating the map, processing the map style and drawing the first tiles arrive in a few big chunks, and when one of those chunks hit during the half-second the icon is rising, the animation froze and lurched (worst on a cold open, invisible on a warm one — which is why some opens looked perfect). Now the app waits: the splash intro plays first with nothing competing, and the heavy start-up begins the moment the intro finishes. The icon also drops its shadow for the final rush (a scaled-up shadow is just a smear, and an expensive one). Same animation, same look — it just gets the phone to itself.

## Beta 1.43 — 2026-10-31

START-UP IMAGE FIX (Andrew spotted it): the still image the phone shows before the app loads had the app icon pasted in as a plain square, while the animated splash that follows it shows the icon with rounded corners and a soft shadow — so the icon flickered square-to-rounded on every cold open. The stills are regenerated to match the animated splash's resting frame exactly: same rounded corners, same shadow, same size, same spot on the screen. Nothing else changes.

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
