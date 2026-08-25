#!/usr/bin/env python3
"""Verify the integrity hashes in the pages against what the CDNs actually serve.

Runs in CI, because nothing offline can tell a correct digest from a plausible
one — the bytes have to be fetched.

This replaced a shell version that used grep to pair a src with its integrity.
grep is line-based and the attributes sit on separate lines, so it matched
nothing, reported "no integrity attribute yet" for every script, and passed. A
check that reports success while checking nothing is worse than no check.
"""
import base64, glob, hashlib, re, sys, urllib.request

TAG = re.compile(r'<script\b[^>]*?>', re.S)
ATTR = lambda name, tag: (re.search(name + r'="([^"]*)"', tag, re.S) or [None, None])[1]

def main():
    want, seen = {}, 0
    for path in sorted(glob.glob('*.html')):
        for tag in TAG.findall(open(path, encoding='utf-8').read()):
            src = ATTR('src', tag)
            if not src or not src.startswith('http'):
                continue
            seen += 1
            integrity, crossorigin = ATTR('integrity', tag), ATTR('crossorigin', tag)
            if not integrity:
                print('::error::%s loads %s with no integrity attribute' % (path, src)); return 1
            if not crossorigin:
                print('::error::%s has integrity but no crossorigin — SRI in name only' % path); return 1
            if want.setdefault(src, integrity) != integrity:
                print('::error::%s carries a different hash for %s' % (path, src)); return 1

    if not want:
        print('::error::found no external scripts at all — the parser is broken, not the pages')
        return 1
    print('%d script tags across the pages, %d distinct URLs\n' % (seen, len(want)))

    bad = 0
    for url, expected in sorted(want.items()):
        try:
            req = urllib.request.Request(url, headers={'Origin': 'https://ila.cafe'})
            with urllib.request.urlopen(req, timeout=30) as r:
                body, acao = r.read(), r.headers.get('Access-Control-Allow-Origin')
        except Exception as e:
            print('::error::could not fetch %s: %s' % (url, e)); bad = 1; continue

        got = 'sha384-' + base64.b64encode(hashlib.sha384(body).digest()).decode()
        if got != expected:
            print('::error::%s changed at a pinned version' % url)
            print('::error::  committed %s' % expected)
            print('::error::  served    %s' % got)
            bad = 1
        elif not acao:
            # crossorigin="anonymous" makes the browser send Origin and refuse the
            # script unless the CDN allows it. Missing, this shows up not as a failed
            # check but as a blank till.
            print('::error::%s sends no Access-Control-Allow-Origin' % url)
            print('::error::  crossorigin="anonymous" will stop this script loading at all')
            bad = 1
        else:
            print('  OK  %s\n      %s  ACAO: %s' % (url, got, acao))
    return bad

if __name__ == '__main__':
    sys.exit(main())
