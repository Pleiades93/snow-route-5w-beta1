#!/usr/bin/env python3
"""CSP stamp tool for the Snow Route tracker.

The tracker's production page gets a Content-Security-Policy as a <meta>
tag whose script/style allowances are SHA-384 hashes of the page's OWN
inline <script> and <style> blocks. The hash is the whole point: any edit
to the app code changes the fingerprint, so a policy stamped for one build
refuses to run the next build's code until it is re-stamped. That makes
the policy self-maintaining ONLY if the stamp is mechanical - which is
what this tool is. Nobody hand-edits the hash; this script computes it.

Usage:
  csp_stamp.py policy <file.html>   print the policy computed from the file
  csp_stamp.py apply  <file.html>   insert/replace the CSP meta in the file
  csp_stamp.py verify <file.html>   exit 0 iff the file's stamped policy
                                    exactly matches a fresh computation
                                    (drift = code changed, stamp stale)

Design notes (adjudicated 2026-10-28):
- The canonical source (src/tracker-source.html) stays UNSTAMPED. The
  stamp is a property of built outputs: build-pages.py applies it to the
  generated index.html and --check verifies it, alongside the existing
  parity and SEC-10a gates. A stale stamp therefore fails the build
  instead of shipping.
- Policy shape: default-src 'none', then explicit allowances inventoried
  from the page itself - the two CDN origins that serve the pinned,
  SRI-checked libraries (unpkg for Leaflet in the canonical file,
  jsdelivr for the MapLibre tags the Pages build injects), the three map
  hosts (Esri tiles, OpenFreeMap, CARTO), same-origin for the update
  check's self-fetch and the manifest, blob: workers for MapLibre GL.
  style-src-attr 'unsafe-inline' is required: the app carries a few
  static style="" attributes (element styles set from JS are not
  CSP-governed); the <style> BLOCK stays hash-locked via style-src-elem.
- A <meta> CSP cannot express frame-ancestors/reporting; GitHub Pages
  cannot send headers at all, so the meta is the only channel there.
  The service worker's own fetches are not governed by the page policy;
  the worker keeps verifying SRI itself (SEC-10).
"""
import base64
import hashlib
import re
import sys

POLICY_TEMPLATE = (
    "default-src 'none'; "
    "script-src 'sha384-{script}' https://cdn.jsdelivr.net; "
    "style-src-elem 'sha384-{style}' https://cdn.jsdelivr.net; "
    "style-src-attr 'unsafe-inline'; "
    "img-src 'self' data: blob: "
    "https://tiles.basemaps.cartocdn.com https://protomaps.github.io "
    "https://cdn.jsdelivr.net; "
    "connect-src 'self' "
    "https://tiles.basemaps.cartocdn.com https://protomaps.github.io "
    "https://cdn.jsdelivr.net; "
    "worker-src blob:; child-src blob:; "
    "font-src 'none'; manifest-src 'self'; "
    "base-uri 'none'; form-action 'none'; object-src 'none'"
)

INLINE_SCRIPT_RE = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.S)
INLINE_STYLE_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.S)
CSP_META_RE = re.compile(
    r'<meta http-equiv="Content-Security-Policy" content="[^"]*">')
CSP_META_LINE_RE = re.compile(
    r'\n<meta http-equiv="Content-Security-Policy" content="[^"]*">')
CHARSET_RE = re.compile(r'(<meta charset="[^"]*">)')


def _hash(text):
    return base64.b64encode(hashlib.sha384(text.encode("utf-8")).digest()).decode()


def compute_policy(html):
    scripts = INLINE_SCRIPT_RE.findall(html)
    styles = INLINE_STYLE_RE.findall(html)
    if len(scripts) != 1 or len(styles) != 1:
        raise SystemExit(
            f"expected exactly 1 inline script and 1 inline style, "
            f"found {len(scripts)}/{len(styles)}")
    return POLICY_TEMPLATE.format(script=_hash(scripts[0]), style=_hash(styles[0]))


def apply_stamp(html):
    meta = f'<meta http-equiv="Content-Security-Policy" content="{compute_policy(html)}">'
    if CSP_META_RE.search(html):
        return CSP_META_RE.sub(meta, html, count=1)
    if not CHARSET_RE.search(html):
        raise SystemExit("no charset meta found to anchor the CSP meta after")
    return CHARSET_RE.sub(r"\1\n" + meta, html, count=1)


def stamped_policy(html):
    m = re.search(
        r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', html)
    return m.group(1) if m else None


def strip_stamp(html):
    """Remove the stamped meta (and the newline apply_stamp added with it),
    restoring the exact pre-stamp bytes. Used by build-pages.py's parity
    check, which compares the de-transformed bundle against the source."""
    return CSP_META_LINE_RE.sub("", html, count=1)


def main(argv):
    if len(argv) != 3 or argv[1] not in ("policy", "apply", "verify"):
        print(__doc__)
        return 2
    cmd, path = argv[1], argv[2]
    with open(path, encoding="utf-8") as f:
        html = f.read()
    if cmd == "policy":
        print(compute_policy(html))
        return 0
    if cmd == "apply":
        stamped = apply_stamp(html)
        with open(path, "w", encoding="utf-8") as f:
            f.write(stamped)
        print(f"stamped {path}")
        return 0
    # verify
    current = stamped_policy(html)
    if current is None:
        print("verify: NO CSP meta present")
        return 1
    expected = compute_policy(html)
    if current == expected:
        print("verify: stamp matches the page's own code - OK")
        return 0
    print("verify: STALE STAMP - the page code changed since stamping")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
