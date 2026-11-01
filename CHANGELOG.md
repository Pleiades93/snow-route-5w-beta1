# Changelog

## Beta 1.63 - 2026-11-01
Data correctness, from the Beta 1.60 deep audit (adjudicated the same
day; findings F01-F04):
- F01: a note draft now belongs to its street. renderStreets records
  which street's editor is in the DOM (noteEdFor); switching streets
  finalizes the old editor against ITS street before the new one
  renders, and a draft is only ever restored into its own street's
  editor. One street's note can no longer appear in - or be saved to -
  another street.
- F02: the Finish rollback is verified (write checked + read back).
  If rolling the archive back fails, the message says the archive
  could not be undone and asks for a backup export, instead of
  claiming the clean is intact. The Undo mirror rollback is verified
  the same way.
- F03: lsDel returns its result and saveStart propagates it, so a
  failed deletion of the run-start record surfaces through saveAll
  like any other failed write (it used to report success regardless).
- F04: success messages now branch on the save result - Saved /
  Note saved / Clean deleted / All marks cleared / Clean started are
  only claimed when the write landed; otherwise the message names
  the storage problem.
Tests: drive136 gains the rollback-failure (F6) and removeItem (F7)
fault cases; new drive140 covers the note-draft matrix (switch with a
pending draft, both streets noted, same-street re-render).
## Beta 1.62 - 2026-11-01
Cleanup, at Andrew's direction (the post-strip soak deferral was lifted
the same day): the strip-era machinery comes out now that the
document-height floor (1.60) holds the full stage on its own.
- The 1.58 recovery nudges are REMOVED (function, counters, and the
  syncViewport call): they moved the page by design and could still
  twitch once during the splash handoff even though the stage now
  always arrives full.
- The 1.54 viewport trust override is REMOVED: syncViewport publishes
  the live report, always. fullH remains only as the keyboard settle
  sampler's reference.
- The #diag diagnostic readout (1.55, always labelled temporary) is
  REMOVED, element and tap handler together; its job - classifying the
  strip - is done and device-verified.
- The four strip-test probe pages are removed from the site.
drive135's trust assertions are rewritten to the live-rules contract
(V4/V5); drive137 (the nudge test) is retired with the machinery.
## Beta 1.61 - 2026-11-01
Keyboard overlay, at Andrew's direction: while a note field is focused,
the keyboard now slides OVER the app instead of resizing it. The layout
variables (--vvt/--vvh/--vvb) freeze at their pre-keyboard values for the
whole typing session (syncViewport returns early while body.kb), and the
sheets keep their pre-keyboard size and place (the 1.31 near-full-height
sheet rule is gone). This replaces 1.55's live-tracking, whose per-tick
re-fitting of the sheets against the keyboard's rise animation made both
note menus flicker and jump (pre-dating 1.60; Andrew's readout caught the
visible height chasing 932 -> 740 mid-animation). Field visibility -
the problem 1.55's tracking was solving - is now handled inside the
menu: once the keyboard's rise settles, ensureFieldVisible scrolls the
sheet's own list so the field sits above the keyboard, or shifts the
pop-up/modal card up by the overlap (cleared when the keyboard leaves).
drive135's keyboard contract is rewritten to the freeze (V2c) plus a
holds-against-the-tick-stream check (F1).
## Beta 1.60 - 2026-11-01
The short-stage FIX, at the source: a document-height floor on the root
element (min-height: min(100lvh, calc(100% + env(safe-area-inset-top)))).
The strip investigation's final lead, from third-party iOS 26/27 reports:
WebKit keeps a Home Screen app's layout viewport short while its document
is no taller than that viewport, and grants the full screen once the
document is at least screen-tall - which is also why ordinary (long,
scrollable) websites never showed the defect. Proven on Andrew's iPhone
(iOS 27.2) the same day with bare probe pages, fresh installs (the worst
bucket): base probe innerHeight 873 at cold launch/resume/keyboard;
probes with this rule (A) and with a screen-height JS floor (B) both held
932 through all three. A is ported (pure CSS, effective from first
layout). Beta 1.59's boot heal is RETIRED UNMERGED - with the sizing
fixed at the source, a reload would only recreate the same document. The
1.54-1.58 viewport machinery stays for now as inert fallback (it never
engages at full size); its removal is a separate round once 1.60 has
soaked on the phone. The diagnostic readout also stays until the strip
has been absent across Andrew's 30-launch acceptance count. drive139
pins the rule's presence, its document-tall precondition, and unchanged
layout; the cure itself is WebKit behaviour and is phone-judged.
## Beta 1.59 - 2026-11-01
Boot heal for the short-stage launches. The strip investigation (same day)
closed the root-cause question: iOS chooses the layout viewport's size
before the page's first layout - intermittently 59pt short on this
install, permanently short on fresh installs - and no page code can reach
the missing strip (proven with a bare reproduction page; WebKit 313800).
One mechanism remained untried and evidence-led: a fresh layout sometimes
lands full (reopening the app fixes some bad launches), so when a launch
is still short after the settle window the app now reloads ONCE, behind
the splash, to re-roll the layout - standalone only, portrait only, never
over an open clean, loop-guarded per launch. Every outcome is tallied in
local storage and shown in the diagnostic readout as "heal A/R/S"
(attempted / recovered / still short): if iOS locks the size per launch,
R stays 0 and the mechanism comes back out. The 1.58 nudges stay for the
mid-session (keyboard) cases. drive138 pins the heal.
## Beta 1.58 — 2026-11-01
- **Fullscreen strip: classified, and now actively fought (with receipts).** The diagnostic screenshots settled the cause: in the bad state the window height, visible area, bottom bar's lower edge and map's lower edge *all* read 873 against a 932 physical screen — a shortfall of exactly 59px, the status-bar height. iOS intermittently sizes the installed app's window short; the app inside it is laid out correctly and cannot paint into screen it does not own. So instead of another layout layer, the app now *detects* the shortfall (it knows the settled height) and jolts the browser toward recomputing the window — a one-frame root-height toggle plus a scroll nudge — at the moments the shrink appears (launch, resume, keyboard close). Nudges are rate-limited (2.5s apart) and capped (12 per session), and the diagnostic readout now counts attempts/recoveries (`nudge A/R`), so real-world launches will show whether the jolts ever recover the full screen. The separate lever remains deleting and re-adding the home-screen shortcut, which refreshes the launch configuration iOS froze when it was first added.

## Beta 1.57 — 2026-11-01
- **Storage integrity (external audit Phase 2 + Section 7).** Saving progress has a failure contract now: the side-completion record — the authority the board rebuilds itself from at launch — is written first, every write is checked, and the first failure is named; a failed save warns once per episode ("Storage is not saving — export a backup now") instead of silently desyncing. **Finish is a transaction:** the archive record and the cleared board are both written and verified *before* any state changes, and a failure rolls the archive back — a storage error can no longer leave a finished clean resurrecting beside its own archive entry. **Undo follows the same discipline** and stays on offer if its writes fail. A metadata-only failure during Finish completes the finish with an honest note in the confirmation.
- **Offline-cache upkeep (second audit).** The tile-cache trim counter is now seeded from the cache's real size when the background worker wakes (iOS stops the worker constantly, which kept resetting the in-memory count and could let the cache drift past its cap). Opaque (status-unknowable) responses are no longer cached for CDN files. The app now also asks the platform to exempt its data from automatic storage eviction where supported (`storage.persist()` — an installed home-screen app is already outside Safari's 7-day tab rule; this covers tab use and other browsers).
- **Wording:** the offline-download refusal message no longer ends with an instruction that only made sense to the author.
- **Documentation sweep (known leftover B09, confirmed by the second audit):** README and architecture docs described retired map technology (OpenFreeMap, Esri fallback tiles, VersaTiles, even Leaflet); they now describe the actual stack — embedded Protomaps styles, CARTO vector tiles, MapLibre GL.

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
