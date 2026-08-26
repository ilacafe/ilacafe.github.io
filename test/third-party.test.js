// Every page loads code from someone else's server, straight into the origin that
// holds the till, the ledger and the customer's phone number. There is no build
// step and no bundler, so whatever that server returns is what runs.
//
// Two things make that survivable: pinning a version, so the code cannot change
// under you; and Subresource Integrity, so it cannot change even at that version.
// This suite enforces the first and reports on the second.

const { readPage, suite } = require('./helpers');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'chef.html', 'barista.html', 'inventory.html'];

// A URL is pinned when it names a version that a CDN cannot reinterpret.
//   .../firebasejs/8.10.1/...        pinned
//   .../npm/chart.js@4.5.1           pinned
//   .../npm/chart.js                 NOT pinned — resolves to whatever is newest
const PINNED = [
  /\/firebasejs\/\d+\.\d+\.\d+\//,
  /@\d+\.\d+\.\d+(?:[/?#]|$)/,
  /\/\d+\.\d+\.\d+\//,
];

const { check, note, done } = suite('Third-party code — pinned, and accounted for');

const tags = [];
for (const page of PAGES) {
  const src = readPage(page);
  for (const m of src.matchAll(/<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>/g)) {
    const url = m[2];
    if (!/^https?:\/\//.test(url)) continue;                 // same-origin is ours
    tags.push({ page, url, attrs: m[1] + m[3] });
  }
}

check('there is third-party code to check at all', tags.length > 0);

{
  const floating = tags.filter(t => !PINNED.some(re => re.test(t.url)));
  check('every external script names an exact version',
        floating.length === 0,
        floating.map(t => t.page + ' → ' + t.url).join(', '));
  note('an unpinned URL is a standing invitation for a CDN to change what runs on the till');
}

{
  // Distinct origins, because each one is a party that can change your pages.
  const origins = [...new Set(tags.map(t => new URL(t.url).origin))].sort();
  check('and comes from no more than two origins', origins.length <= 2, origins.join(', '));
  note('origins: ' + origins.join(', '));

  const byUrl = new Map();
  for (const t of tags) byUrl.set(t.url, (byUrl.get(t.url) || 0) + 1);
  note([...byUrl.entries()].sort().map(([u, n]) => n + '× ' + u.replace(/^https:\/\//, '')).join('\n       '));
}

{
  // Loaded but never referenced: all of the risk, none of the function. pdf.js sat
  // in admin.html this way — 3.11.174, on the page that edits prices and roles.
  const IDENT = {
    'firebase-app.js': /\bfirebase\./,
    'firebase-auth.js': /\bfirebase\.auth\b|\bauth\b\s*=/,
    'firebase-database.js': /\bfirebase\.database\b|\bdb\b\s*=/,
    'chart.js': /\bnew Chart\b|\bChart\./,
    'pdf.min.js': /\bpdfjsLib\b|\bPDFJS\b|getDocument\(/,
  };
  const unused = [];
  for (const t of tags) {
    const key = Object.keys(IDENT).find(k => t.url.includes(k.replace('.min', '')) || t.url.includes(k));
    if (!key) continue;
    if (!IDENT[key].test(readPage(t.page))) unused.push(t.page + ' loads ' + key + ' and never calls it');
  }
  check('no page loads a library it never calls', unused.length === 0, unused.join(', '));
}

{
  // Pinning stops the version moving. SRI stops the file moving at that version —
  // a CDN account compromise, or a cache poisoned in front of it, is otherwise
  // indistinguishable from a normal load on a page that takes card payments.
  const without = tags.filter(t => !/\bintegrity=/.test(t.attrs));
  check('every external script declares an integrity hash',
        without.length === 0, without.map(t => t.page + ' → ' + t.url).join(', '));

  check('and declares crossorigin alongside it',
        tags.filter(t => !/\bcrossorigin=/.test(t.attrs)).length === 0,
        'integrity without crossorigin is ignored by the browser — SRI in name only');

  const bad = tags.filter(t => !/integrity="sha(256|384|512)-[A-Za-z0-9+/]+=*"/.test(t.attrs));
  check('every hash is a well-formed sha256/384/512 digest', bad.length === 0,
        bad.map(t => t.page + ' → ' + t.url).join(', '));

  // The same URL must carry the same hash on every page, or one page is loading a
  // file the others would reject.
  const byUrl = new Map();
  for (const t of tags) {
    const h = /integrity="([^"]+)"/.exec(t.attrs)[1];
    if (!byUrl.has(t.url)) byUrl.set(t.url, new Map());
    byUrl.get(t.url).set(h, (byUrl.get(t.url).get(h) || 0) + 1);
  }
  const split = [...byUrl.entries()].filter(([, hs]) => hs.size > 1);
  check('and one URL never carries two different hashes', split.length === 0,
        split.map(([u]) => u).join(', '));
  note('the hashes themselves are verified against the live files by CI, not here —');
  note('nothing offline can tell a correct digest from a plausible one');
}

// ---------------------------------------------------------------- no shared secret in a page
// The push relay used to be authorised by a secret that four pages carried, which
// meant anyone who viewed source could send any notification to every admin device.
// It is retired: the relay takes a Firebase ID token and the pages hold nothing.
//
// This is the check that keeps it that way. Reintroducing a constant like it is an
// easy thing to do while adding a new alert, and impossible to notice by eye.
{
  // Matched on the shape of the VALUE, not the name. A name-based rule flags
  // TABLE_CACHE_KEY = 'ila_cached_tables' and misses a secret assigned to something
  // innocuous — the wrong way round on both counts.
  const looksLikeCredential = (v) =>
    (/^[0-9a-f]{24,}$/i.test(v)) ||                                  // hex, as the old push secret was
    (v.length >= 20 && /^[A-Za-z0-9+/=_-]+$/.test(v) &&
     /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v));         // base64-ish, mixed case

  const found = [];
  for (const page of PAGES) {
    for (const m of readPage(page).matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"\s]{16,})['"]/g)) {
      if (!looksLikeCredential(m[2])) continue;
      // Public by design: they identify the project, they do not authorise anything.
      if (/^AIza/.test(m[2])) continue;                              // Firebase web API key
      if (/^B[A-Za-z0-9_-]{80,}$/.test(m[2])) continue;              // VAPID public key
      if (/^sha(256|384|512)-/.test(m[2])) continue;                 // SRI digests
      // An alphabet has every character exactly once; a random secret of this length
      // drawn from 16 or 64 symbols always repeats. That separates Firebase's
      // push-key charset from a credential without having to list either.
      if (new Set(m[2]).size === m[2].length) continue;
      found.push(page + ': ' + m[1]);
    }
  }
  check('no page carries a secret that authorises anything', found.length === 0, found.join(', '));
  note('a secret a browser must hold is a secret anyone can read');
}

done();
