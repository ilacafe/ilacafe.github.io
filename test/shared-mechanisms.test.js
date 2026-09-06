// The mechanisms every page is supposed to have, and the pages that did not have them.
//
// Several things here are cross-cutting by design — the offline bar, the update
// banner, the shell cache, the app's own dialogs. Each was added once and then wired
// into the pages one at a time, by hand, and a page gets missed. Nothing said so,
// because a page missing one of these is not broken: it is slower, or quieter, or a
// little further behind, which is exactly the kind of fault this project keeps
// finding late.
//
// Three mechanisms, and until this file they covered three different subsets of the
// seven pages:
//
//   connection.js   all seven
//   build-check.js  six — inventory.html had none, so the stock tablet was never
//                   offered a new build and could sit weeks behind with nothing on
//                   screen to say so and nothing to tap
//   sw.js           five — analytics.html and inventory.html registered no service
//                   worker at all, so neither had a shell cache and every open
//                   fetched the page whole. analytics.html is 177KB.
//
// THE SERVICE WORKER ONE WAS A REPORT FROM THE OWNER, not a hunch: reopening the app
// straight after closing it was fast, and reopening it later was much slower. That is
// what a page with no shell cache does. GitHub Pages sends a ten-minute HTTP cache
// (sw.js says so in its own comments, which is why it revalidates with 'no-cache'),
// so inside ten minutes the browser's own cache answered and the open was instant;
// after ten minutes there was nothing between the page and the network. A page the
// service worker holds is served from Cache Storage either way, which is why the till
// and the ordering page never showed it.
//
// admin.html was a fourth case and the most fragile: it registered the worker only
// inside notifInit(), which returns early on any device that cannot take web push. So
// whether admin opened quickly depended on whether the browser did notifications, two
// things with nothing to do with each other.
//
// This is a source check on purpose. Whether a page LOADS these is stateable without
// a browser, and the browser suites already ask the harder question of whether each
// mechanism then works.

const { readPage, suite } = require('./helpers');

const { check, note, done } = suite('Shared mechanisms — every page carries every one');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'chef.html', 'barista.html', 'inventory.html'];

// Each mechanism, what it is for, and how to tell it is wired in.
const MECHANISMS = [
  {
    name: 'connection.js',
    why:  'says out loud that the screen has stopped talking to the database, and is ' +
          'where a refused read and an uncaught error are recorded',
    has:  (src) => /<script[^>]+src=["']\/connection\.js["']/.test(src),
  },
  {
    name: 'build-check.js',
    why:  'offers the reload when a newer build has shipped — the only way a screen ' +
          'left open all day ever picks one up',
    has:  (src) => /<script[^>]+src=["']\/build-check\.js["'][^>]*data-build=/.test(src),
  },
  {
    name: 'the service worker',
    why:  'the shell cache, which is the difference between an open that is instant ' +
          'and one that fetches the whole page over café wifi',
    has:  (src) => /serviceWorker\.register\(/.test(src),
  },
];

const src = {};
PAGES.forEach(p => { src[p] = readPage(p); });

for (const m of MECHANISMS) {
  const missing = PAGES.filter(p => !m.has(src[p]));
  check('every page loads ' + m.name, missing.length === 0,
        missing.join(', ') + ' — ' + m.why);
}

// ---------------------------------------------------------------- dialogs, where used
//
// dialogs.js is the one that is NOT universal, and asserting it everywhere was wrong:
// the two kitchen boards are display surfaces with a DONE button and they ask nothing
// of anybody, so a page that never says a word correctly does not load the module for
// saying words. The real rule is the conditional one, and it is the stronger of the
// two — a page that CALLS ilaToast without loading dialogs.js throws a ReferenceError
// at the moment it most needs to tell somebody something.
{
  const CALLS = /\bila(Toast|Tell|Ask|AskText|FieldError)\s*\(/;
  const users = PAGES.filter(p => CALLS.test(src[p]));
  const missing = users.filter(p => !/<script[^>]+src=["']\/dialogs\.js["']/.test(src[p]));
  check('every page that speaks loads dialogs.js', missing.length === 0,
        missing.join(', ') + ' — calling ilaToast without the module is a ReferenceError');
  note(users.length + ' of ' + PAGES.length + ' pages say anything at all; the kitchen boards do not');
  // The other half of this — that nothing has gone back to alert(), confirm() or
  // prompt() — belongs to dialogs-browser.test.js, which already asks it and strips
  // comments first. A second copy here matched the word "alert" inside the comment
  // explaining why alert is not used, which is the kind of check that looks like
  // coverage and is noise.
}

// ---------------------------------------------------------------- and unconditionally
//
// Registering inside a feature's own setup is how admin.html came to have a shell
// cache only on devices that support push. The registration has to be reachable on
// every load, not from inside a function that can return before it.
{
  const offenders = [];
  for (const p of PAGES) {
    const s = src[p];
    // The register call, and the 400 characters before it. A registration whose
    // nearest preceding `return` sits closer than the start of the page's boot is a
    // registration something can skip.
    const idx = s.indexOf('serviceWorker.register(');
    if (idx < 0) continue;                      // already reported above
    const before = s.slice(Math.max(0, idx - 400), idx);
    // `if ('serviceWorker' in navigator)` is the guard this is allowed to sit behind.
    const guarded = /'serviceWorker'\s+in\s+navigator/.test(before);
    const afterAReturn = /\breturn\b[^;]*;[\s\S]{0,200}$/.test(before);
    if (!guarded && afterAReturn) offenders.push(p);
  }
  check('and registers it on every load, not from inside a feature that can bail first',
        offenders.length === 0,
        offenders.join(', ') + ' — a shell cache that depends on push support is not a shell cache');
  note('admin.html registered it only inside notifInit(), which returns early with no push');
}

// ---------------------------------------------------------------- the cost, stated
//
// Not a pass/fail: the point of the list is that somebody has looked at how big the
// thing is that a missing shell cache would be fetching.
{
  const sizes = PAGES.map(p => ({ p, kb: Math.round(src[p].length / 1024) }))
                     .sort((a, b) => b.kb - a.kb);
  note('page weight, which is what an open without a shell cache pays: ' +
       sizes.map(s => s.p.replace('.html', '') + ' ' + s.kb + 'KB').join(', '));
}

done();
