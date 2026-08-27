// Nothing that stops the parser sits in the head.
//
// Each of these pages is one file: markup, styles and several thousand lines of
// its own JavaScript, with the Firebase SDK loaded from a CDN. A plain <script
// src> in the head stops the parser dead — nothing below it is parsed, let alone
// painted, until the file has arrived AND compiled. For the better part of 400KB
// of SDK that is the whole of a cold open spent on a blank page, on a counter
// tablet, a kitchen screen, or a customer's phone on café wifi.
//
// The fix is only two moves, and BOTH are needed. The tags go to the foot of the
// body so they no longer block. A rel=preload goes in the head where they used to
// be, so the download still starts at the same instant — without it the tag is not
// even discovered until the parser reaches the bottom, and the page ends up slower
// to become usable than it was before. Doing half of this looks like an
// improvement and is not, which is why both halves are checked here.
//
// boot-order-browser.test.js is the other half of this: it loads the real bundles
// into the real pages and watches the page get parsed while the SDK is still in
// flight. This suite is the cheap one that runs on every push and reads the source.

const { readPage, suite } = require('./helpers');

const { check, note, done } = suite('The head does not block the page');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'chef.html', 'barista.html', 'inventory.html'];

const TAG = /<script\b[^>]*?>/gs;
const LINK = /<link\b[^>]*?>/gs;
const attr = (name, tag) => (new RegExp(name + '="([^"]*)"', 's').exec(tag) || [])[1];
const isOffOrigin = (src) => !!src && /^https?:\/\//.test(src);

// Comments are stripped before anything is looked at, and this is not fussiness.
// The note beside the stylesheet in each page explains itself by NAMING the tags
// involved, so the source text of a comment contains things that read exactly like
// markup. Scanning it raw, the strip below ran from the word in that prose to the
// real closing tag and quietly took the stylesheet with it — leaving this suite
// reporting that no page blocks on a stylesheet, on a page that did.
const markup = (page) => readPage(page).replace(/<!--[\s\S]*?-->/g, '');

// ---------------------------------------------------------------- the head
{
  const blocking = [];
  for (const page of PAGES) {
    const src = markup(page);
    const head = src.slice(0, src.indexOf('</head>'));
    for (const tag of head.match(TAG) || []) {
      const url = attr('src', tag);
      if (!isOffOrigin(url)) continue;                  // our own small files are fine
      if (/\bdefer\b|\basync\b/.test(tag)) continue;    // does not block the parser
      blocking.push(page + ' → ' + url);
    }
  }
  check('no page has a render-blocking third-party script in its head',
        blocking.length === 0, blocking.join(', '));
  note('a plain <script src> there is a blank screen for as long as the file takes');
}

// -------------------------------------------------------------- the stylesheet
// A stylesheet in the head blocks the paint exactly the way a script does, and
// once the SDK moved out this one-kilobyte file from another origin was the only
// thing still doing it. Measured with the font server answering in 800ms, first
// paint was ~890ms on the ordering page and ~900ms on the till; with it made
// non-blocking, ~196ms and ~132ms. The page was ready the whole time.
//
// media="print" is what makes it non-blocking — it does not apply to the screen,
// so nothing waits for it — and the onload swaps it to all when it lands. That
// costs nothing to look at, because the URL already asks for display=swap: the
// text was always going to be painted in the fallback face and re-painted in
// Quicksand afterwards.
{
  const blocking = [], noFallback = [];
  for (const page of PAGES) {
    const src = markup(page);
    // <noscript> holds a deliberately ordinary copy for the case where onload can
    // never fire. It is inert with script on, so it must not be read as a blocker.
    const head = src.slice(0, src.indexOf('</head>')).replace(/<noscript>[\s\S]*?<\/noscript>/g, '');

    let sawFont = false;
    for (const tag of head.match(LINK) || []) {
      if (!/rel="stylesheet"/.test(tag)) continue;
      sawFont = true;
      // Anything that applies to the screen on arrival is holding the first paint.
      if (!/media="print"/.test(tag)) blocking.push(page + ' → ' + attr('href', tag));
      if (!/onload=/.test(tag)) blocking.push(page + ' → ' + attr('href', tag) + ' never becomes active');
    }
    if (sawFont && !/<noscript>[\s\S]*?rel="stylesheet"[\s\S]*?<\/noscript>/.test(src)) {
      noFallback.push(page);
    }
  }
  check('no page holds its first paint for a stylesheet',
        blocking.length === 0, blocking.join(', '));
  check('and each one still applies itself once it arrives, with a no-script copy',
        noFallback.length === 0, noFallback.join(', '));
}

// ------------------------------------------------- everything it does load, early
{
  const unpreloaded = [], mismatched = [];
  for (const page of PAGES) {
    const src = markup(page);
    const head = src.slice(0, src.indexOf('</head>'));

    const preloads = new Map();                          // href -> tag
    for (const tag of head.match(LINK) || []) {
      if (!/rel="preload"/.test(tag)) continue;
      preloads.set(attr('href', tag), tag);
    }

    for (const tag of src.match(TAG) || []) {
      const url = attr('src', tag);
      if (!isOffOrigin(url)) continue;
      if (/\bdefer\b|\basync\b/.test(tag)) continue;     // discovered early already
      const pre = preloads.get(url);
      if (!pre) { unpreloaded.push(page + ' → ' + url); continue; }

      // A preload only satisfies the real request when the mode and the integrity
      // metadata match it. Mismatched, the browser fetches the same file twice —
      // strictly worse than not preloading at all, and invisible without looking.
      if (attr('integrity', pre) !== attr('integrity', tag) ||
          attr('crossorigin', pre) !== attr('crossorigin', tag)) {
        mismatched.push(page + ' → ' + url);
      }
    }
  }
  check('every blocking-position script it still loads is preloaded from the head',
        unpreloaded.length === 0, unpreloaded.join(', '));
  note('otherwise the download does not start until the parser reaches the bottom');

  check('and the preload matches the tag, so the file is fetched once not twice',
        mismatched.length === 0, mismatched.join(', '));
}

// ------------------------------------------------------------- order still holds
// The page's own script calls firebase.initializeApp on its first working line, so
// the SDK has to have run by then. Two ways that breaks while still looking right:
// a tag ending up below the inline script, or someone adding defer to one of them —
// deferred scripts run after the parser finishes, which is after the inline script
// has already run and already thrown.
{
  const wrongOrder = [], deferred = [], notLast = [];
  for (const page of PAGES) {
    const src = markup(page);
    const app = src.search(/\n\s*<script>\s*\n/);        // the page's own inline code

    let last = -1;
    for (const m of src.matchAll(/<script\b[^>]*?\bsrc="([^"]*firebasejs[^"]*)"[^>]*?>/gs)) {
      if (m.index > app) { wrongOrder.push(page + ' → ' + m[1]); continue; }
      if (/\bdefer\b|\basync\b/.test(m[0])) deferred.push(page + ' → ' + m[1]);
      if (m.index < last) wrongOrder.push(page + ' → ' + m[1] + ' is out of order');
      last = m.index;
    }

    // "At the foot of the body" is only true while nothing follows it.
    const after = src.slice(src.lastIndexOf('</script>')).replace(/<\/script>/, '');
    if (/<(?!\/(body|html))[a-zA-Z]/.test(after)) notLast.push(page);
  }
  check('the SDK still runs before the page that initialises it',
        wrongOrder.length === 0, wrongOrder.join(', '));
  check('and is still loaded synchronously, not deferred',
        deferred.length === 0, deferred.join(', ') + ' — defer here runs AFTER the inline script');
  check('the page’s own script is still the last thing in the document',
        notLast.length === 0, notLast.join(', '));
}

done();
