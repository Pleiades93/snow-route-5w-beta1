#!/usr/bin/env python3
"""Build the deployable GitHub Pages files from the canonical source.

BETA 1 form (2026-10-29): the app is a pure MapLibre GL build - the canonical
source already carries the MapLibre tags and there is no Leaflet, no plugin
and no raster/vector mode flip. The build applies exactly ONE scripted
change to the source:
  1. a Content-Security-Policy <meta> stamped by scripts/csp_stamp.py, whose
     script/style hashes are computed from the bundle itself
and copies src/sw.js to sw.js. It then verifies:
  * parity  - stripping the stamp reproduces the source byte-for-byte
  * SEC-10a - the service worker's CORE integrity hashes and URLs equal the
              deployed page tags' (the two copies of the SRI data cannot drift)
  * CSP     - the bundle's stamped policy exactly matches a fresh hash
              computation over the bundle's own inline script/style

Usage:
  python3 scripts/build-pages.py           build + verify (writes index.html, sw.js)
  python3 scripts/build-pages.py --check   verify only (used by CI)

Standard library only; no dependencies.
"""
import hashlib
import re
import sys
from pathlib import Path

import csp_stamp

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / 'src' / 'tracker-source.html'
SW_SRC = REPO / 'src' / 'sw.js'
OUT_INDEX = REPO / 'index.html'
OUT_SW = REPO / 'sw.js'

GL_CSS = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css" integrity="sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V" crossorigin="anonymous">'
GL_JS = '<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js" integrity="sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj" crossorigin="anonymous"></script>'


def build(src_text: str) -> str:
    s = src_text
    for needle in (GL_CSS, GL_JS):
        assert s.count(needle) == 1, f'anchor not unique/found: {needle[:60]} (count={s.count(needle)})'
    assert 'leaflet@' not in s and 'maplibre-gl-leaflet' not in s, 'Beta 1 source must not load Leaflet or the plugin'
    # The stamp goes on LAST: its hashes cover the bundle's own inline
    # script/style, exactly as the browser will receive them.
    return csp_stamp.apply_stamp(s)


def verify(bundle: str, src_text: str, sw_text: str) -> None:
    stamped = csp_stamp.stamped_policy(bundle)
    assert stamped is not None, 'CSP FAIL: bundle carries no Content-Security-Policy meta'
    assert stamped == csp_stamp.compute_policy(bundle), 'CSP FAIL: stamped policy does not match the bundle code - stale stamp'
    for host in ('tiles.basemaps.cartocdn.com', 'protomaps.github.io'):
        assert f'https://{host}' in stamped, f'CSP FAIL: policy omits map host {host} - the styles fetch tiles/glyphs/sprites from it (2026-10-29 dark-mode incident: tiles.basemaps.cartocdn.com was missing and the whole dark basemap was policy-blocked)'
    assert "worker-src blob: 'self'" in stamped, 'CSP FAIL: worker-src does not allow the same-origin service worker - registration would be policy-blocked and ALL offline capability silently dies (2026-11-01 incident: preload reported saved 0 of 894 on a working connection)'
    import pathlib
    chg = pathlib.Path(__file__).resolve().parent.parent.joinpath('CHANGELOG.md').read_text()
    mv = re.search(r'## Beta (\d+\.\d+)', chg)
    assert mv, 'VERSION FAIL: CHANGELOG has no Beta entry'
    assert f'id="ver">Beta {mv.group(1)}<' in bundle, f'VERSION FAIL: the displayed version is not the CHANGELOG top entry (Beta {mv.group(1)}) - the in-app update checker compares this text; a stale label disables update detection (2026-11-01: 1.53 shipped still displaying Beta 1.52 because a label edit silently matched nothing)'
    print(f'VERSION check: PASS (displayed version == CHANGELOG top, Beta {mv.group(1)})')
    print('CSP check: PASS (stamped policy hash matches the bundle\'s own script/style)')
    r = csp_stamp.strip_stamp(bundle)
    assert r == src_text, 'PARITY FAIL: index.html differs from source beyond the CSP stamp'
    print('parity check: PASS (index.html == source + the CSP stamp, nothing else)')
    tag_hashes = set(re.findall(r'integrity="(sha384-[^"]+)"', bundle))
    core_pairs = re.findall(r"\['(https://[^']+)', '(sha384-[^']+)'\]", sw_text)
    assert len(core_pairs) == 2, f'SEC-10a: expected 2 CORE pairs in sw.js, found {len(core_pairs)}'
    assert set(h for _, h in core_pairs) == tag_hashes, 'SEC-10a FAIL: sw.js CORE hashes differ from the page tags - SRI drift'
    tag_urls = set(re.findall(r'(?:src|href)="(https://[^"]+)"[^>]*integrity=', bundle))
    assert set(u for u, _ in core_pairs) == tag_urls, 'SEC-10a FAIL: sw.js CORE urls differ from the page tags'
    print('SEC-10a check: PASS (sw.js CORE == page tags, 2 urls + hashes)')


def main() -> int:
    check_only = '--check' in sys.argv[1:]
    src_text = SRC.read_text(encoding='utf-8')
    sw_text = SW_SRC.read_text(encoding='utf-8')
    bundle = build(src_text)
    verify(bundle, src_text, sw_text)
    if check_only:
        ok = True
        if OUT_INDEX.read_text(encoding='utf-8') != bundle:
            print('CHECK FAIL: index.html differs from a fresh build')
            ok = False
        if OUT_SW.read_text(encoding='utf-8') != sw_text:
            print('CHECK FAIL: sw.js differs from src/sw.js')
            ok = False
        if not ok:
            return 1
        print('check: PASS (committed index.html and sw.js match a fresh build)')
        return 0
    OUT_INDEX.write_text(bundle, encoding='utf-8')
    OUT_SW.write_text(sw_text, encoding='utf-8')
    data = bundle.encode()
    print('index.html:', len(data), 'bytes, SHA-256', hashlib.sha256(data).hexdigest())
    print('sw.js: copied from src/sw.js')
    return 0


if __name__ == '__main__':
    sys.exit(main())
