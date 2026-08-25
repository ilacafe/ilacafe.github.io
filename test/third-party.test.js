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
  const without = tags.filter(t => !/\bintegrity=/.test(t.attrs));
  // Not yet a failure: an integrity hash cannot be invented, it has to be computed
  // from the file the CDN actually serves. The deploy workflow prints them — see
  // .github/workflows/test.yml, job "third-party hashes" — and once they are in the
  // pages this turns into a hard check.
  check('every script carrying an integrity hash also declares crossorigin',
        tags.filter(t => /\bintegrity=/.test(t.attrs) && !/\bcrossorigin=/.test(t.attrs)).length === 0,
        'integrity without crossorigin is silently ignored by the browser');
  if (without.length) {
    note(without.length + ' of ' + tags.length + ' script tags have no integrity hash yet');
    note('pinning stops the version moving; SRI stops the file moving at that version');
  }
}

done();
