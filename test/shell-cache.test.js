// What the service worker holds, and what it is allowed to hold forever.
//
// The shell cache serves everything from itself and revalidates in the background,
// except for a short list of URLs that can only ever answer with one file — those
// are served from cache and never re-fetched. Getting that list wrong is expensive
// in one direction and dangerous in the other: too small and a kitchen tablet spends
// the slowest part of its open confirming that immutable files are still immutable;
// too large and a device is frozen on one build of something forever.
//
// cdn.jsdelivr.net was the last host on any page that the cache did not hold at all,
// so Chart.js — which analytics draws every one of its charts with — was the one
// piece of the app shell that came off the network however many times the page had
// been opened.
//
// It qualifies on exactly the terms the Firebase SDK does, and this suite checks the
// terms rather than the conclusion: the URL names a version, and the page carries an
// SRI hash for that build. An unpinned jsdelivr URL means "whatever is newest" and
// must NOT be treated as immutable, which is the case that would be silent.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('The shell cache — what it holds, and what it holds forever');

const sw = readPage('sw.js');
const api = buildModule([extractFunction(sw, 'isImmutable')], {}, ['isImmutable']);
const immutable = (u) => api.isImmutable(new URL(u));

// ---------------------------------------------------------------- the allowlist
{
  const m = /const CACHEABLE_HOSTS = \[([^\]]*)\]/.exec(sw);
  const hosts = m ? m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
  check('the service worker names the hosts it will cache', hosts.length > 0, sw.slice(0, 80));

  // Every off-origin thing the pages actually FETCH. Scripts and stylesheets only:
  // the first version of this swept every <link> and reported ila.cafe and the
  // database host as uncached, which are a canonical URL and a preconnect — one is
  // metadata and the other is a handshake, and neither is a file anybody downloads.
  // Derived from the pages so a new dependency added tomorrow has to be a decision
  // here rather than a silent miss.
  const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
                 'chef.html', 'barista.html', 'inventory.html'];
  const loaded = new Set();
  for (const p of PAGES) {
    const src = readPage(p).replace(/<!--[\s\S]*?-->/g, '');
    for (const m2 of src.matchAll(/<script\b[^>]*\bsrc="(https:\/\/[^"]+)"/g))
      loaded.add(new URL(m2[1]).hostname);
    for (const m2 of src.matchAll(/<link\b[^>]*>/g)) {
      if (!/rel="stylesheet"/.test(m2[0])) continue;          // not preconnect, not canonical
      const href = /href="(https:\/\/[^"]+)"/.exec(m2[0]);
      if (href) loaded.add(new URL(href[1]).hostname);
    }
  }
  // The push Worker is a live endpoint, not a file: caching it would answer a
  // subscribe with yesterday's reply.
  const LIVE = new Set(['ila-push.sraveen-chirania.workers.dev']);
  const missing = [...loaded].filter(h => !hosts.includes(h) && !LIVE.has(h));
  check('every off-origin file the pages load is one the cache holds',
        missing.length === 0, missing.join(', '));
  note([...loaded].join(', ') + ' — loaded across the ' + PAGES.length + ' pages');
  check('and jsdelivr is among them', hosts.includes('cdn.jsdelivr.net'), hosts.join(', '));
}

// ---------------------------------------------------------------- served forever
{
  check('a font file is immutable', immutable('https://fonts.gstatic.com/s/quicksand/v40/x.woff2'));
  check('a pinned Firebase SDK is immutable',
        immutable('https://www.gstatic.com/firebasejs/12.17.1/firebase-app-compat.js'));
  check('and so is a pinned Chart.js',
        immutable('https://cdn.jsdelivr.net/npm/chart.js@4.5.1'));

  // The one that would be silent. jsdelivr serves this happily and it means
  // "whatever is newest", so cache-first on it pins a device to one build for good.
  check('an UNPINNED jsdelivr url is not',
        !immutable('https://cdn.jsdelivr.net/npm/chart.js'),
        'an unversioned URL would be frozen in the cache forever');
  note('the version in the path is the whole reason it can be held — so it is checked');

  // Revalidated, not frozen: Google rewrites this stylesheet, and our own HTML
  // changes on every deploy.
  check('the Google Fonts stylesheet is still revalidated',
        !immutable('https://fonts.googleapis.com/css2?family=Quicksand'));
  check('and so is our own HTML', !immutable('https://ila.cafe/pos.html'));
}

// ---------------------------------------------------------------- the page agrees
{
  const analytics = readPage('analytics.html').replace(/<!--[\s\S]*?-->/g, '');
  const tag = /<script[^>]*src="(https:\/\/cdn\.jsdelivr\.net\/[^"]+)"[^>]*>/.exec(analytics);
  check('analytics loads Chart.js from jsdelivr', !!tag, 'no jsdelivr script tag found');
  check('from a url that names its version', !!tag && /@\d+\.\d+\.\d+/.test(tag[1]),
        tag ? tag[1] : '-');
  check('and the url it uses is one the cache may hold forever',
        !!tag && immutable(tag[1]), tag ? tag[1] : '-');
  note('the page and the service worker have to agree, or the rule applies to nothing');

  // SRI is what makes holding it safe: a truncated cache entry is rejected rather
  // than run, which is the failure the "served forever" rule cannot otherwise catch.
  const withSri = new RegExp('<script[^>]*src="' + (tag ? tag[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : 'x') +
                             '"[^>]*integrity="sha\\d+-[^"]+"', 's');
  const alt = new RegExp('integrity="sha\\d+-[^"]+"[^>]*src="' + (tag ? tag[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : 'x') + '"', 's');
  check('and it carries an SRI hash, which is what makes holding it safe',
        withSri.test(analytics) || alt.test(analytics),
        'no integrity attribute on the jsdelivr tag');
}

// ------------------------------------------------- the precache list is not orphaned
// The worker warms the three SDK bundles into the cache when a page says it has
// finished loading, so that the SECOND open does not download 400KB again with nothing
// on screen. To do that it names the URLs, which means it carries a copy of the version
// the pages are pinned to.
//
// A version bumped in seven HTML files and not here is the failure this exists for: it
// breaks nothing, throws nothing, and reads as fixed. The worker would quietly warm
// three files no page ever asks for, every page would go back to being slow on its
// second open, and there is nothing on screen connecting the two.
{
  const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
                 'chef.html', 'barista.html', 'inventory.html'];
  const wanted = new Set();
  for (const p of PAGES) {
    const src = readPage(p).replace(/<!--[\s\S]*?-->/g, '');
    for (const m of src.matchAll(/<script\b[^>]*\bsrc="(https:\/\/www\.gstatic\.com\/firebasejs\/[^"]+)"/g))
      wanted.add(m[1]);
  }
  check('the pages load the SDK from pinned urls', wanted.size >= 3,
        wanted.size + ' found: ' + [...wanted].join(', '));

  const base = (/const SDK_BASE = '([^']+)'/.exec(sw) || [])[1];
  const held = new Set([...(sw.match(/SDK_BASE \+ '([^']+)'/g) || [])]
    .map(m => base + /SDK_BASE \+ '([^']+)'/.exec(m)[1]));
  check('the worker names some to warm', held.size > 0, [...held].join(', '));

  const missing = [...wanted].filter(u => !held.has(u));
  check('and every one the pages load is one it warms', missing.length === 0,
        missing.join(', ') + ' — the worker\u2019s SDK_BASE has drifted from the pages');

  const orphans = [...held].filter(u => !wanted.has(u));
  check('with none left over that no page asks for', orphans.length === 0,
        orphans.join(', ') + ' — warmed by the worker, loaded by nobody');
  note('a version bumped in the pages and not in sw.js warms three files nobody wants');

  // And they have to be on the terms the rest of this file is about, or warming them
  // is storing something that can never be served back.
  const notImmutable = [...held].filter(u => !immutable(u));
  check('and the worker may hold them forever, which is why warming them is worth it',
        notImmutable.length === 0, notImmutable.join(', '));
}

done();
