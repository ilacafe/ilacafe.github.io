// The iOS launch screen, and the two ways it silently stops working.
//
// An installed home-screen app on iOS shows a launch image while the page loads. It
// wants apple-touch-startup-image — one file per device size and orientation — and with
// none present it shows black, which is what the café reported on all seven apps.
//
// Both failures here are silent. A tag pointing at a file that is not deployed gets no
// image and no error: iOS falls back to black, exactly as if the tag were missing, and
// the only way to see it is to launch the app on that device. And a page that never got
// the tags at all looks identical to the six that did, from everywhere except that
// page's own launch.
//
// So this checks the tags against the files on disk, in both directions, on every page.

const fs = require('fs');
const path = require('path');
const { ROOT, readPage, suite } = require('./helpers');

const { check, note, done } = suite('The iOS launch screen — every page, every file');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'chef.html', 'barista.html', 'inventory.html'];
const DIR = path.join(ROOT, 'splash');

const tagsOf = (page) => {
  const src = readPage(page).replace(/<!--[\s\S]*?-->/g, '');
  return [...src.matchAll(/<link\b[^>]*rel="apple-touch-startup-image"[^>]*>/g)].map(m => m[0]);
};

// ------------------------------------------------------------------ every page has them
{
  const without = PAGES.filter(p => tagsOf(p).length === 0);
  check('every app gives iOS something to draw while it loads',
        without.length === 0, without.join(', ') + ' — these still launch black');

  // They have to be the SAME set. A page that quietly gained a device the others did
  // not is one iPhone launching black with nothing on screen to say which.
  const counts = new Map(PAGES.map(p => [p, tagsOf(p).length]));
  const first = counts.get(PAGES[0]);
  const odd = PAGES.filter(p => counts.get(p) !== first);
  check('and all of them cover the same devices',
        odd.length === 0, [...counts].map(([p, n]) => p + ':' + n).join(' '));
  note(first + ' sizes and orientations, on each of the ' + PAGES.length + ' apps');
}

// ------------------------------------------------------- the files are actually there
{
  const onDisk = fs.existsSync(DIR) ? new Set(fs.readdirSync(DIR).filter(f => f.endsWith('.png'))) : new Set();
  check('the splash images are in the repo', onDisk.size > 0, DIR + ' is empty or missing');

  const referenced = new Set();
  const missing = [];
  for (const page of PAGES) {
    for (const tag of tagsOf(page)) {
      const href = (/href="([^"]+)"/.exec(tag) || [])[1] || '';
      const file = href.replace(/^\/splash\//, '');
      referenced.add(file);
      if (!onDisk.has(file)) missing.push(page + ' → ' + href);
    }
  }
  check('and every tag points at one that exists',
        missing.length === 0, [...new Set(missing)].slice(0, 6).join(', '));
  note('a tag pointing at a file that is not deployed launches black and says nothing');

  const unused = [...onDisk].filter(f => !referenced.has(f));
  check('with none in the repo that no page asks for',
        unused.length === 0, unused.join(', ') + ' — dead weight in the deploy');
}

// ---------------------------------------------------------- the media query is usable
// Every queried tag has to name a device, an orientation and a pixel ratio, or it does
// not identify a device at all: no orientation and a landscape kitchen display gets the
// portrait image.
//
// EXACTLY ONE TAG IS ALLOWED NO QUERY, AND IT IS REQUIRED.
//
// This suite used to forbid that, and the rule cost the café the whole feature. Every
// queried tag is an exact match against a device that existed when it was written;
// Apple ships new sizes every year; and the café runs recent iPad Pros, which changed
// size. Nothing matched, iOS fell straight back to black, and the deploy was
// indistinguishable from never having shipped — the floor reported the same black
// screen and there was nothing to say which of the two it was.
//
// The un-queried tag matches everything, so an unknown device gets a scaled brand
// screen instead. It goes LAST: among matching links order decides, and first in the
// list it could shadow every exact match.
{
  const tags = tagsOf(PAGES[0]);
  const queryOf = (t) => (/media="([^"]+)"/.exec(t) || [])[1];
  const unqueried = tags.filter(t => !queryOf(t));

  check('there is a fallback for a device nobody has thought of yet',
        unqueried.length === 1, unqueried.length + ' tags carry no media query');
  note('without one, a device Apple ships next year is black and looks like a broken deploy');
  check('and it is the last of them, so an exact match still wins',
        unqueried.length === 1 && tags[tags.length - 1] === unqueried[0],
        'the un-queried tag is at position ' + (tags.indexOf(unqueried[0]) + 1) + ' of ' + tags.length);

  const noOrientation = [], noRatio = [];
  for (const tag of tags) {
    const media = queryOf(tag);
    if (!media) continue;                                  // the fallback, checked above
    if (!/orientation:\s*(portrait|landscape)/.test(media)) noOrientation.push(media.slice(0, 60));
    if (!/-webkit-device-pixel-ratio:\s*\d/.test(media)) noRatio.push(media.slice(0, 60));
  }
  check('every other one says which way up', noOrientation.length === 0, noOrientation.join(', '));
  check('and at what pixel ratio', noRatio.length === 0, noRatio.join(', '));
}

// ------------------------------------------------- the devices the café actually runs
// Named rather than counted, because "31 tags" is true of a set that misses the one
// iPad in the building. These two are the M4 iPad Pros — the sizes that were missing
// when this shipped the first time and turned the whole thing into a no-op.
{
  const media = tagsOf(PAGES[0]).map(t => (/media="([^"]+)"/.exec(t) || [])[1] || '').join(' | ');
  const need = [[834, 1210, 'iPad Pro 11-inch (M4)'], [1032, 1376, 'iPad Pro 13-inch (M4)'],
                [820, 1180, 'iPad Air 11-inch'],     [1024, 1366, 'iPad Pro 12.9-inch']];
  const missing = need.filter(([w, h]) =>
    !new RegExp('device-width:\\s*' + w + 'px.*?device-height:\\s*' + h + 'px').test(media));
  check('the iPads in the café are among them',
        missing.length === 0, missing.map(m => m[2]).join(', ') + ' — these launch black');
}

done();
