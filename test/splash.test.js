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
// A tag without one applies to every device, so iOS takes whichever it saw last and
// stretches it. They also have to name an orientation, or a landscape kitchen display
// gets the portrait image.
{
  const noMedia = [], noOrientation = [], noRatio = [];
  for (const tag of tagsOf(PAGES[0])) {
    const media = (/media="([^"]+)"/.exec(tag) || [])[1];
    if (!media) { noMedia.push(tag.slice(0, 60)); continue; }
    if (!/orientation:\s*(portrait|landscape)/.test(media)) noOrientation.push(media.slice(0, 60));
    if (!/-webkit-device-pixel-ratio:\s*\d/.test(media)) noRatio.push(media.slice(0, 60));
  }
  check('each one says which device it is for', noMedia.length === 0, noMedia.join(', '));
  check('and which way up', noOrientation.length === 0, noOrientation.join(', '));
  check('and at what pixel ratio', noRatio.length === 0, noRatio.join(', '));
}

done();
