// A till left on all day never picked up a fix. sw.js serves the cached shell and
// revalidates in the background, so a new build lands in the cache but applies only
// on the NEXT open — and a tablet propped up on the counter has no next open, nor
// does a kitchen display that runs from open to close. Even a single reload serves
// the previous fetch, which is why deploying anything meant walking round reloading
// each screen twice.
//
// The watcher lives in build-check.js and every long-lived page loads it, carrying
// its own build on the tag. Four things have to hold or the mechanism is decoration:
// every such page must load it, the stamp must match what build.json says, the poll
// must not be answered from the cache it exists to defeat, and a failed fetch must
// not look like a new version.

const fs = require('fs');
const path = require('path');
const { ROOT, readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Build freshness — a screen that never closes');

// Every page a member of staff leaves open. index.html is here because a customer
// tracking an order sits on it for the length of the order.
const STAMPED = ['pos.html', 'admin.html', 'index.html', 'chef.html', 'barista.html'];

const watcher = readPage('build-check.js');

// ---------------------------------------------------------------- every page loads it
{
  const missing = [];
  for (const page of STAMPED) {
    if (!/<script src="\/build-check\.js" data-build="[^"]+"><\/script>/.test(readPage(page))) {
      missing.push(page);
    }
  }
  check('every long-lived page loads the watcher', missing.length === 0, missing.join(', '));
  note('the kitchen screens are open longest and were the last to get this');

  // document.currentScript is null for a deferred or async script, and the build
  // would silently read as null — the watcher would run and never fire.
  const deferred = STAMPED.filter(p => /<script[^>]*build-check\.js[^>]*(defer|async)/.test(readPage(p)));
  check('and loads it synchronously', deferred.length === 0,
        deferred.join(', ') + ': document.currentScript is null for defer/async');
}

// ---------------------------------------------------------------- the stamp agrees
{
  const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'build.json'), 'utf8')).build;
  check('build.json declares a build', typeof declared === 'string' && declared.length > 0, String(declared));

  const mismatched = [];
  for (const page of STAMPED) {
    const m = /build-check\.js" data-build="([^"]+)"/.exec(readPage(page));
    if (!m) { mismatched.push(page + ': no data-build'); continue; }
    if (m[1] !== declared) mismatched.push(page + ': ' + m[1] + ' ≠ ' + declared);
  }
  check('and every stamped page carries exactly that build',
        mismatched.length === 0, mismatched.join(', '));
  note('drift here is silent: the banner would either never fire or never stop');

  // The pages show it at their foot. If the watcher stopped publishing it, that
  // line would read "build undefined" and nobody would notice for weeks.
  check('the watcher publishes the build for the pages to display',
        /window\.ILA_BUILD\s*=/.test(watcher));
  const stale = STAMPED.filter(p => /const ILA_BUILD =/.test(readPage(p)));
  check('and no page still declares a build of its own', stale.length === 0,
        stale.join(', ') + ': two builds, and the one on the tag is the one that counts');
}

// ---------------------------------------------------------------- the poll can reach the network
{
  const sw = readPage('sw.js');
  check('the service worker does not serve build.json from its cache',
        /url\.pathname === '\/build\.json'\)\s*return/.test(sw),
        'the poll would be answered with the build the page already has, forever');

  // The manifest is the same trap with a longer fuse. build.json going stale stops
  // the update banner; the manifest going stale means a device keeps opening the app
  // the way it was configured the day it was installed — and a reinstall reads the
  // cached copy too, so the usual remedy quietly does nothing. That is how a shipped
  // display change came back from the floor as "reinstall done, still the same".
  check('nor the manifest, which is what an install reads',
        /url\.pathname === '\/manifest\.webmanifest'\)\s*return/.test(sw),
        'an installed device would keep the display, theme and splash it first saw');

  // Skipping it from now on leaves the copy already stored on every device that has
  // one. activate() deletes any cache whose name is not the current one, so the name
  // has to move whenever something wrongly cached needs dropping.
  check('and the cache name moved, so the stale copy is actually dropped',
        /const CACHE = 'ila-shell-v(?!1')/.test(sw),
        'excluding it going forward does nothing for a device that already cached it');

  check('the watcher fetches build.json with cache: no-store',
        /fetch\('\/build\.json',\s*\{\s*cache:\s*'no-store'\s*\}\)/.test(watcher));

  check('and keeps polling rather than checking once at load',
        /setInterval\(checkForNewBuild/.test(watcher) &&
        /visibilitychange/.test(watcher),
        'a screen that is never reloaded is also never re-checked');
}

// ---------------------------------------------------------------- a failed fetch is not an update
{
  const api = buildModule([extractFunction(watcher, 'buildIsNewer')], {}, ['buildIsNewer']);

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
  note('a missing data-build makes the watcher inert, not noisy');
}

// ---------------------------------------------------------------- it reloads into the new build
{
  check('the watcher clears the shell cache before reloading',
        /caches\.keys\(\)[\s\S]{0,220}indexOf\('ila-shell'\)[\s\S]{0,120}location\.reload\(\)/.test(watcher),
        'a plain reload is served the cached shell again — the same two-reload problem');
}

// ---------------------------------------------------------------- it never reloads by itself
{
  const upToArming = watcher.slice(0, watcher.indexOf('setTimeout(checkForNewBuild'));
  check('it never reloads without being asked',
        !/checkForNewBuild[\s\S]{0,200}applyNewBuild\(\)/.test(upToArming) &&
        /getElementById\('ila-update-now'\)\.onclick = applyNewBuild/.test(watcher),
        'a till reloading itself mid-transaction is worse than the bug being fixed');

  // The only text in the banner comes from build.json, but it reaches the DOM as
  // text rather than as markup, so a mangled build string cannot become an element.
  check('the banner is built from nodes, not from a string of HTML',
        !/innerHTML/.test(watcher));
}

done();
