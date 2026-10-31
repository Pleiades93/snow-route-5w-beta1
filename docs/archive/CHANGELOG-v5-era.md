# Changelog archive — pre-beta (v5) era

These entries came with the original app this beta was rebuilt from. They are kept as history only; the current app's changes are in `CHANGELOG.md`.

## v5.81 — 2026-10-28
If every map source fails at once (no signal and nothing cached), the app now says so instead of sitting on a blank grey background: a dismissible notice — "Maps can't load — streets, GPS and marking still work. Check your connection." — appears once tile requests have failed with not one tile loaded, and clears itself the moment a tile gets through. Streets, GPS, pace and marking were never affected by a dead basemap; now the app explains the situation instead of leaving it ambiguous. (The one new item from the 2026-10-28 second-opinion audit.)

## v5.79 — 2026-10-27
Consecutive same-side green edges now join across stretch boundaries: when the stretch next door has the same side done, a side's green edge runs untrimmed right to the shared boundary, so a run of finished stretches reads as one continuous green line down that side of the road. An isolated finished stretch keeps its small end trims and floats on its own, exactly as before. Verified by a full trace audit (drive111) over all 34 streets: every centreline point sits on the road's true geometry, every green edge rides at the intended 6 px offset on the correct physical side, joins measure closed, and no line overshoots its road.

## v5.78 — 2026-10-27
Andrew's live-test fixes to the stretches build: the arrow chips are smaller (40 px) and sit further off the road (40 px from the centreline) so they no longer crowd it; completed work reads more solid at rest — a both-sides stretch rests at 0.85 opacity and a green side edge at 0.9 (selected street still goes full 1.0, pending streets still rest at 0.58). Pace integration: every side now records the moment it was cleaned (pieceTimes, stored with the pieces as {p, t} under the same sides key; the v5.77 bare format still loads), and pace/ETA plus the progress meter run off side-metres — a side counts when it is cleaned, not when its street completes, so a street cleaned in two passes an hour apart no longer books all its metres at the second pass. doneM remains the road-metre figure (side-metres / 2), so totals, the last-clean verdict math and end-of-run numbers are unchanged; the meter's % is now work done (streets fully done still shown as the count beside it).

## v5.77 — 2026-10-27
Streets are cleaned in stretches × sides (Andrew's design): each street is cut at its junctions into stretches (87 route-wide), and each stretch has two physical sides. A completed side gets one green line hugging that side of the street; the street completes when every stretch is done both sides, and counts/pace/history stay street-level. Tapping a street selects the stretch under the tap and pops two arrow chips — fan-family white/slate circles with Set C glyphs — one on each physical side of the road; tapping a chip marks that side (chip turns into a green check; tap again to un-mark). The panel's Mark completed still completes the whole street. Piece state lives in the existing sides storage key (new format, validated per street); pre-v5.77 progress and old backups migrate automatically (a completed street = all its pieces done).

## v5.76 — 2026-10-27
- The GPS follows the run (Andrew): pressing Start clean turns
  positioning on, and Finish turns it off - no manual toggling.
  Undoing a finish turns it back on; cancelling a start turns off
  only a GPS the start itself turned on.
- The red-button rule now covers the whole exit family (Andrew):
  Cancel start, the finish pop-up's No, Not yet, Not now, Keep, and
  the previous-clean view's Back are red too, not just Close.

## v5.75 — 2026-10-27
- Every Close button is now red (Andrew): in the Export panel all the
  buttons looked the same and the way out got lost. The List sheet's
  Close and the Export panel's Close use the app's street red.

## v5.74 — 2026-10-27
- Map pictures load while you pan instead of only after you stop
  (they used to start from zero at every stop), and the Export panel
  gains "Download route maps (offline)": one tap saves every map
  picture covering the route - day and night styles - to the phone,
  so panning the route in the field never waits on the network and
  the map works with no signal. The panel reports how many files
  were saved.

## v5.73 — 2026-10-27
- No more map flicker on zoom (Andrew's report): the map pictures
  themselves used to fade in one by one as they downloaded at a new
  zoom level, which read as flickering. The fade is off on both map
  styles now - a picture appears at full strength the moment it is
  ready, and the previous zoom's picture holds solid until then.

## v5.72 — 2026-10-27
- Instant zoom (Andrew's pick after trying the alternatives): the
  zoom's snap animation is off, so when you let go of a pinch the new
  zoom is simply there - street names and road shapes are final in
  the same instant, with no glitch and no late adjustment. Zooms
  jump instead of gliding; panning and GPS follow are unchanged.
  (v5.71 tried pre-setting the sizes as the zoom started and glitched
  on release; reverted the same day.)

## v5.69 — 2026-10-27
- GPS follow smoothing: fixes are filtered (poor-accuracy gate, jitter
  deadband when barely moving, short-window average) into one accepted
  position; the blue dot glides between fixes instead of teleporting,
  and follow now pans gently — the map holds still while you are in the
  middle of the screen and tracks from the edge, Waze-style.

## v5.68 — 2026-10-27
- Settings fan and gear icons switched to the bold filled family
  (Set C) at Andrew's call, superseding v5.67's line set before the
  GitHub push: solid gear, map pin, house, moon/sun, circular flip
  arrows, and a solid download arrow for Update.

## v5.67 — 2026-10-27
- Settings fan and gear: every icon is now one consistent Apple-style
  line-icon family (drawn icons in the SF Symbols spirit) — gear,
  location crosshair, home, moon/sun, flip arrows, and a download tray
  for Update — Andrew's picks (Set B icons, T1 text).
- Text: SF Pro (the iPhone system font) now applies everywhere,
  including the street names on the map (previously a different font).

## v5.66 — 2026-10-27
- Backup safety prompts: after a clean is saved, a banner offers a one-tap
  backup export (share sheet / file download). On open, when saved cleans
  exist and the last export is over a week old — or has never happened —
  the banner offers a fresh copy; "Not now" snoozes it for a week. Exports
  made from the Export panel are recorded too.

## v5.65 — 2026-10-27
- Pace panel animation now exactly matches the List sheet's — a full-height
  sweep with the same timing in both directions, no fade.

## v5.64 — 2026-10-27
- Pace panel animates open and closed instead of popping (superseded by
  v5.65's exact-match rebuild).

## v5.63 — 2026-10-27
- Fixed the settings fan's fold-back: icons visibly fly back into the gear
  in reverse order instead of vanishing one by one.

## v5.62 — 2026-10-27
- Settings fan order: pin, home, night, flip, update (on top). Update icon
  enlarged.

## v5.61 — 2026-10-27
- The settings fan stays open when you use an item (e.g. switching night
  mode back and forth). Smoother open/close motion.

## v5.60 — 2026-10-27
- Fan icons spaced so they never overlap.

## v5.58 — 2026-10-27
- All corner controls consolidated into one settings fan at the bottom
  right; the hamburger menu is gone. The gear matches the day/night theme.

## v5.56 — 2026-10-27
- Header buttons reordered: List, Pace, Finish.

## v5.55 — 2026-10-27
- Fixed: the Undo state no longer pushes header buttons off-screen. In the
  street list, tapping a street opens its note editor.

## v5.54 — 2026-10-27
- Finish button (replaces Reset) with a confirmation pop-up summarizing
  the run. Deleting a clean returns to Previous cleans.

## v5.53 — 2026-10-27
- Per-street notes, auto-saved and filed with each archived clean. Tap a
  previous clean for full detail — per-street times and notes. Cleans can
  be deleted.

## v5.52 — 2026-10-27
- "Update app" button: checks for a newer build and reloads into it with
  confirmation. Menu and banner animations.

## v5.51 — 2026-10-27
- Reliability: clearing the GPS trail no longer reports success when the
  save failed; restore verifies its reads honestly; service-worker cache
  writes are awaited.

## v5.50 — 2026-10-27
- Installed-app header fixed (content sits below the iOS top band).
  Version label added under the title.

## v5.48 — 2026-10-27
- Visual polish: shared design tokens, panel accents, progress percentage
  in the header count.

## v5.47 — 2026-10-27
- Security hardening: offline caching accepts only integrity-verified
  library copies; notes and restore robustness fixes from an external
  audit.
