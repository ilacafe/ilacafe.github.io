// A till left on all day never picked up a fix. sw.js serves the cached shell and
// revalidates in the background, so a new build lands in the cache but applies only
// on the NEXT open — and a tablet propped up on the counter has no next open. Even a
// single reload serves the previous fetch, which is why deploying anything has meant
// walking round reloading each tablet twice.
//
// The pages now poll build.json and offer a reload. Three things have to hold or the
// mechanism is decoration: the stamp must match what the pages carry, the poll must
// not be answered from the cache it exists to defeat, and a failed fetch must not
// look like a new version.

const fs = require('fs');
const path = require('path');
const { ROOT, readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Build freshness — a till that never closes');

const STAMPED = ['pos.html', 'admin.html', 'index.html'];

// ---------------------------------------------------------------- the stamp agrees
{
  const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'build.json'), 'utf8')).build;
  check('build.json declares a build', typeof declared === 'string' && declared.length > 0, String(declared));

  const mismatched = [];
  for (const page of STAMPED) {
    const m = /const ILA_BUILD = '([^']+)'/.exec(readPage(page));
    if (!m) { mismatched.push(page + ': no ILA_BUILD'); continue; }
    if (m[1] !== declared) mismatched.push(page + ': ' + m[1] + ' ≠ ' + declared);
  }
  check('and every stamped page carries exactly that build',
        mismatched.length === 0, mismatched.join(', '));
  note('drift here is silent: the banner would either never fire or never stop');
}

// ---------------------------------------------------------------- the poll can reach the network
{
  const sw = readPage('sw.js');
  check('the service worker does not serve build.json from its cache',
        /url\.pathname === '\/build\.json'\)\s*return/.test(sw),
        'the poll would be answered with the build the page already has, forever');

  for (const page of STAMPED) {
    const src = readPage(page);
    check(page + ' fetches build.json with cache: no-store',
          /fetch\('\/build\.json',\s*\{\s*cache:\s*'no-store'\s*\}\)/.test(src));
  }
}

// ---------------------------------------------------------------- a failed fetch is not an update
{
  const api = buildModule([extractFunction(readPage('pos.html'), 'buildIsNewer')], {}, ['buildIsNewer']);

  check('a genuinely different build is an update',
        api.buildIsNewer('2026-08-25.7', '2026-08-26.1') === true);
  check('the same build is not', api.buildIsNewer('2026-08-25.7', '2026-08-25.7') === false);

  const noise = [
    ['undefined, as from a missing field', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a number', 7],
    ['an object, as from an HTML error page parsed loosely', {}],
  ];
  const wrong = noise.filter(([, v]) => api.buildIsNewer('2026-08-25.7', v) !== false).map(([w]) => w);
  check('and nothing else is', wrong.length === 0, wrong.join(', '));
  note('a banner that cries wolf gets dismissed, and then the real one is dismissed too');

  check('a page with no build of its own never claims to be stale',
        api.buildIsNewer('', '2026-08-26.1') === false &&
        api.buildIsNewer(undefined, '2026-08-26.1') === false);
}

// ---------------------------------------------------------------- it reloads into the new build
{
  for (const page of STAMPED) {
    const src = readPage(page);
    check(page + ' clears the shell cache before reloading',
          /caches\.keys\(\)[\s\S]{0,220}indexOf\('ila-shell'\)[\s\S]{0,120}location\.reload\(\)/.test(src),
          'a plain reload is served the cached shell again — the same two-reload problem');
  }
}

// ---------------------------------------------------------------- it never reloads by itself
{
  for (const page of STAMPED) {
    const src = readPage(page);
    const watcher = src.slice(src.indexOf('A TILL THAT STAYS OPEN'), src.indexOf('setTimeout(checkForNewBuild'));
    check(page + ' never reloads without being asked',
          !/checkForNewBuild[\s\S]{0,200}applyNewBuild\(\)/.test(watcher) &&
          /getElementById\('ila-update-now'\)\.onclick = applyNewBuild/.test(src),
          'a till reloading itself mid-transaction is worse than the bug being fixed');
  }
}

done();
