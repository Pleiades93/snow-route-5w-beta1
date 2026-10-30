# Storage Schema — the data contract

Status: **contract**. This schema is shared with production v5.81 and with every
installed beta. Changing any key name, value shape, or the missing-key policy
requires a documented migration, migration tests, and Andrew's approval
(DEVELOPMENT_RULES.md §4). All values live in `localStorage` under the serving
origin. Formats below were verified against the app source and the loaders'
sanitizers on 2026-10-29.

## Keys

| Key | Content | Shape |
|-----|---------|-------|
| `snow5w.v2` | Completed streets (derived cache) | JSON array of street names. Re-derived from `snow5w.v5.sides` at every load; a non-array value is ignored, never fatal (audit F-3). |
| `snow5w.v2.times` | Completion time per street | JSON object `{street: ISO time}`. |
| `snow5w.v2.history` | Archived cleans, oldest first, max 10 | JSON array of history entries (below). Load sanitizer drops malformed entries. |
| `snow5w.v2.night` | Night-mode flag | String flag. |
| `snow5w.v4.notes` | Per-street notes and flags | JSON object `{street: [ {k, at, text?}, … ]}`; `k` is `note` or a flag kind (`car`, `hazard`, `missed`, `salt`). |
| `snow5w.v4.via` | How each street was marked | JSON object `{street: string}`. |
| `snow5w.v4.trail` | GPS trail of the current run | JSON array of `[lat, lng, epochSeconds]` triples; sanitizer enforces finite, in-range values. |
| `snow5w.v4.cov` | Coverage sample indexes per street | JSON object `{street: [integers]}`; each index must be an integer in `[0, samples)` — enforced at load (audit F-2). |
| `snow5w.v5.start` | Run start | Raw epoch-milliseconds digit string (not JSON). |
| `snow5w.v5.flip` | Legacy flip flag | Retained for format compatibility; unused by the beta (flip was removed in Beta 1.14). Still backed up. |
| `snow5w.v5.sides` | **Source of truth for progress** | JSON `{p: {street: [0..3 per stretch]}, t: {street: {stretchIdx: [timeA, timeB]}}}`. Values are bit flags: 1 = side A, 2 = side B, 3 = both. Load normalizes values to 0..3 (audit G-3). |
| `snow5w.v5.export` | Last export summary (local only) | Not backed up. |
| `snow5w.v5.preload` | Preload record `{at, saved, total}` (local only) | Not backed up. |
| `snow5w.prep.v1` | Offline-prep flag (local only) | Not backed up. |

## History entry

`{at, items, via, notes, sides, km, startedAt, path?}` — `items` maps street →
completion ISO time or null; `notes` and `sides` are deep snapshots taken at
Finish; `path` is the thinned GPS path (optional). An entry archives ONLY when
a run finishes with ≥ 3 streets; the store caps at 10 entries, evicting
non-full runs first (full = all 34 streets).

## Backup envelope

`{app: 'snow5w-backup', v: 1, at, data}` where `data` maps each of the 11
backup keys (all rows above except the three local-only keys) to its raw
stored string. **Missing-key policy:** a key absent from `data` leaves the
current value untouched on restore. A legacy backup whose done value is a
bare object migrates to the sides-derived set (street-name filtered).

## Restore transaction (invariant)

1. Validate envelope identity, version (must be 1), and per-key string/shape
   BEFORE writing anything; reject malformed backups whole.
2. Snapshot every backup key; abort honestly if the snapshot cannot be read.
3. Write each key and re-read to verify.
4. On any failure, roll back from the snapshot and verify the rollback; if the
   rollback itself cannot be verified, say so ("could NOT be fully put back").
5. Reload with the `restoring` flag set, so the unload flush cannot clobber
   the restored data. Nested content is sanitized by the loaders on that
   reload (documented design, audit G-2).

## Versioning rules

- A format change ships as: this document updated, a loader that reads BOTH
  the old and new shapes, a migration on first load, and regression tests for
  both directions (old data loads; new data round-trips).
- Writers never emit a shape the previous release's loaders would crash on
  without a version bump of the envelope (`v`) or key suffix.
- Corrupt values degrade to empty/default at load — never to a boot crash.
