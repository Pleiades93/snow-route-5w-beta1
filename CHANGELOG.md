# Changelog

## Beta 1.56 — 2026-11-01
- **Keyboard ownership (external audit Phase 1).** The typing freeze (`body.kb`) had three owners: the keyboard lifecycle plus two street-list rebuild paths that removed the class directly — a rebuild mid-typing could unfreeze the sheet while the keyboard was still moving. Now the lifecycle in app4 is the single owner: rebuilds call `kbSync()`, which routes through the same settle-release as a normal blur. The settle sampler itself was extracted unchanged into `startKbSettle()`.
- **Competing scroll removed (audit B4).** The note editor no longer runs a delayed smooth `scrollIntoView` (which pans the whole page and fights iOS's own focus pan). It now nudges only the sheet's own scroll position, instantly, if the editor sits outside the sheet's visible box.
- **Diagnostic readout extended** with the element-edge measurements the audit specified: bottom-bar bottom edge, map bottom edge, document/body heights, visual-viewport pageTop and scale. These discriminate an app-owned gap from a browser-owned one: if the bar's edge equals the window height while the window itself is short of the physical screen, the browser owns the strip.

## Beta 1.55 — 2026-11-01
- **Keyboard fix (regression from 1.54, Andrew's report).** 1.54 pinned the menus to their pre-keyboard positions while typing, intending to stop jitter — instead it stopped the menus *riding above the keyboard* (their long-standing behaviour), leaving the note box behind the keyboard and off the visible screen in both the Streets sheet and the selection pop-up. The pin is removed; offsets follow the live visible-area report while typing again. 1.54's other two pieces stay: the settled-size anchor and the freeze-until-settled release (separate mechanisms, not implicated).
- **Temporary diagnostic for the cold-start strip** (still present on 1.54): tap the version label 5 times to toggle a live readout of the size numbers (window height, visible-area height/offset, screen size, settled size, published sizes). One screenshot of it in the bad state identifies which measurement is short, so the next fix lands on the right layer instead of another inference. Removed when the strip is closed.

## Beta 1.54 — 2026-11-01
- **Fullscreen + keyboard hardening (Andrew's deep-dive).** Cold starts still showed the bottom strip ~2 times in 10, and a keyboard cycle (open a note, type, close) could glitch the Streets/selection menus ("reanimates up like opening for the first time") and bring the strip back until the app was relaunched. Root causes: everything was sized from whatever height the phone *last reported*, with no memory of the true size, and iOS sometimes stops reporting after a wrong one; and the menus' freeze-while-typing protection lifted the instant a field lost focus, while the keyboard was still sliding away, so sizes animated against a moving target. Now: the app keeps a **settled size** (the tallest no-keyboard report; in a home-screen install the full screen height is known from the first frame) and trusts it over a stuck short report, so the strip cannot paint; while typing, the bars hold the positions captured as the keyboard opened and only the usable height follows the keyboard; and the freeze now releases only once the reported height has **settled** (back at the settled size or stable across samples, capped ~1.5 s), in one clean change. New drive135 simulates the whole cycle.
- **The version label was stale — fixed and gated.** The 1.53 build still displayed "Beta 1.52" (a label edit in an earlier round silently matched nothing; the in-app update checker compares that text, so the Update button could not have detected the release). The label is corrected, and the build now **refuses to ship** unless the displayed version equals the CHANGELOG's top entry.

## Beta 1.53 — 2026-11-01
- **Offline maps actually save now (the "saved 0 of 894" fix).** Andrew's phone downloaded the offline set and reported "saved 0 of 894 files" on a working connection. Root cause, proven end-to-end: the app's own Content Security Policy stamped `worker-src blob:` only — and the service worker (the component that saves tiles as they pass through it) is a same-origin file, so its registration was **policy-blocked on every load**. The app worked perfectly online (nothing visibly wrong), the registration error was swallowed by a catch labelled "SW is optional", and no offline copy was ever stored. Fix: `csp_stamp.py` now stamps `worker-src blob: 'self'; child-src blob: 'self'` (`blob:` stays for the map library's internal workers), and the build's CSP verification **asserts** `'self'` is present — the build refuses to ship a policy that blocks the worker ever again.
- **The download refuses to lie.** The preload handler now confirms the service worker actually controls the page before fetching (waiting for control the same way the first-boot warm path does); if it still doesn't, the download stops immediately with "Offline maps NOT saved: the part of the app that saves them is not running" instead of burning 894 fetches on a guaranteed zero. A refused registration now records its reason (`window.__swErr`) so the message can name it.
- Same defect exists in production's stamp (v5.81) — flagged to Andrew 2026-11-01; patching production is his separate call.

User-facing changes and important reliability fixes. Versions are the
in-app labels (header, under the app name). Since Beta 1.36 the label is
just "Beta X.Y" and the app is called Snow Route Beta.

## Beta 1.52 — 2026-11-01

The title and version in the top-left move down 10px more (Andrew's calibration: exactly the measured height of the letter B in the big title — his ruler for the distance). They now sit 18px lower than where they started two rounds ago.

## Beta 1.51 — 2026-10-31

Two fixes from Andrew's phone. (1) THE FLOATING BOTTOM BAR: on some launches the app was handed a slightly too-short screen height by the phone and never measured again, so the bottom bar floated with a pale (day) or dark (night) band under it — and reopening the app often just resumed the same frozen page, which is why a reopen only sometimes helped. The app now re-measures the screen at every moment the size is known to have settled: when the page is shown or resumed, when it comes back to the front, on rotation, and in a few automatic re-checks during the first seconds after launch. Measuring costs nothing when the size was already right. (2) The title and version in the top-left sit a little lower (Andrew's ask).

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
