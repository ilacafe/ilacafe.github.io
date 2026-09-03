// The ordering page is what a table QR code opens and what customers send each
// other. It had no description, no share image and no manifest: a shared link
// unfurled as a bare URL, and Android could only offer a bookmark where iOS offered
// an install.
//
// Most of this is declarative, so most of the ways it fails are silent. A manifest
// that names an icon at the wrong size is ignored by Chrome without telling anyone;
// an og:image pointing at a file that is not there shows as a blank card. So the
// checks here are mostly "does this file actually exist, at the size claimed".

const fs = require('fs');
const path = require('path');
const { ROOT, readPage, suite } = require('./helpers');

const { check, note, done } = suite('Ordering page — installable, and shareable');

const idx = readPage('index.html');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));

// PNG dimensions live at a fixed offset in the IHDR chunk.
function pngSize(file) {
  const b = fs.readFileSync(path.join(ROOT, file));
  if (b.slice(1, 4).toString() !== 'PNG') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// ---------------------------------------------------------------- installable
{
  check('the page links the manifest', /<link rel="manifest" href="\/manifest\.webmanifest">/.test(idx));

  for (const k of ['name', 'short_name', 'start_url', 'display', 'icons']) {
    check('the manifest declares ' + k, manifest[k] !== undefined);
  }
  check('it opens standalone rather than in a browser tab', manifest.display === 'standalone');
  check('and starts at the ordering page', manifest.start_url === '/');

  check('theme_color matches the meta tag the page already had',
        manifest.theme_color === (/<meta name="theme-color" content="([^"]+)"/.exec(idx) || [])[1],
        'two different colours means the status bar changes on install');
}

// ------------------------------------------------- the edges Android paints itself
//
// An iPhone looked seamless and an Android did not: the strip behind the home bar came
// out WHITE. Three separate things chose that colour, and every one of them had to be
// told otherwise.
//
//   background_color was #FBF9F6, an off-white. It is the splash, and it is what the
//   installed app paints around the page before the page owns it.
//
//   Five of the seven pages declared no theme-color AT ALL, so Android used its own
//   default for the bars on the till, the boards, the stock tablet and analytics —
//   every screen except the two that happened to have it.
//
//   And no page put a background on <html>. The body's background only propagates to
//   the canvas while the root has none of its own, and the canvas is what Android
//   paints the overscroll gutter and the home-bar strip from. Saying it in both places
//   removes the case where something else gets to choose.
{
  const BRAND = manifest.theme_color;
  const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
                 'chef.html', 'barista.html', 'inventory.html'];

  check('the splash colour is the brand, not an off-white',
        manifest.background_color === BRAND,
        'background_color is ' + manifest.background_color + ', theme_color is ' + BRAND);
  note('it is what the installed app paints around the page before the page owns it');

  const noTheme = PAGES.filter(p => {
    const m = /<meta name="theme-color" content="([^"]+)"/.exec(readPage(p));
    return !m || m[1] !== BRAND;
  });
  check('every page tells Android what colour its bars are', noTheme.length === 0, noTheme.join(', '));

  const noRoot = PAGES.filter(p => !/^\s*html\s*\{[^}]*background/m.test(readPage(p)));
  check('and every page paints the canvas as well as the body', noRoot.length === 0, noRoot.join(', '));
  note('the home-bar strip and the overscroll gutter both come off the canvas');

  // A FOURTH THING GETS TO CHOOSE, and the three above did not cover it.
  //
  // All of that shipped, and the home bar still came out white on one Android phone
  // and BLACK on two others — the same build, three answers. A colour that differs
  // per device is not a colour anyone chose; it is a surface following the device's
  // own light/dark setting, which is what an undeclared `color-scheme` leaves it free
  // to do. theme-color says what the bars are; color-scheme says which way everything
  // the browser draws for us leans, and nothing here had said it.
  //
  // It has to be UNCONDITIONAL. Written inside `@media (prefers-color-scheme: ...)`
  // it is device-dependent again — the exact bug — while still reading like a
  // declaration and still matching any regex that only asks whether the words are
  // present. The first version of this check passed such a page happily. So this
  // counts braces instead: a declaration in a top-level rule sits at depth 1, and one
  // nested inside an at-rule sits deeper, which is the difference that matters.
  const saysItUnconditionally = (src) => {
    const css = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      .map(m => m[1]).join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');        // a comment may hold braces of its own
    let depth = 0;
    for (let i = 0; i < css.length; i++) {
      if (css[i] === '{') { depth++; continue; }
      if (css[i] === '}') { depth--; continue; }
      if (depth === 1 && /^color-scheme:\s*dark/.test(css.slice(i, i + 24))) return true;
    }
    return false;
  };
  const noScheme = PAGES.filter(p => !saysItUnconditionally(readPage(p)));
  check('and every page says which scheme it is, so nothing follows the phone instead',
        noScheme.length === 0, noScheme.join(', '));
  note('white on one phone and black on two is the signature of nobody having said');
}

// ---------------------------------------------------------------- the icons are real
{
  const wrong = [];
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\//, '');
    if (!fs.existsSync(path.join(ROOT, file))) { wrong.push(icon.src + ' does not exist'); continue; }
    const size = pngSize(file);
    if (!size) { wrong.push(icon.src + ' is not a PNG'); continue; }
    if (icon.sizes !== size.w + 'x' + size.h) {
      wrong.push(icon.src + ' claims ' + icon.sizes + ' but is ' + size.w + 'x' + size.h);
    }
  }
  check('every icon exists and is the size the manifest claims',
        wrong.length === 0, wrong.join(', '));
  note('a mismatched size is dropped by Chrome without an error anywhere');

  const biggest = Math.max(...manifest.icons.map(i => parseInt(i.sizes)));
  check('at least one icon is 192px or larger, or it cannot be installed',
        biggest >= 192, 'largest is ' + biggest + 'px');
  note('largest icon: ' + biggest + 'px');
}

// ---------------------------------------------------------------- the share card is real
{
  const tag = (re) => (re.exec(idx) || [])[1];
  const ogImage = tag(/<meta property="og:image" content="([^"]+)"/);
  check('a share image is declared', !!ogImage);

  if (ogImage) {
    const local = ogImage.replace(/^https:\/\/ila\.cafe/, '').replace(/^\//, '');
    check('and it points at a file that exists in this repo',
          fs.existsSync(path.join(ROOT, local)), ogImage);
    const size = pngSize(local);
    const w = tag(/<meta property="og:image:width" content="([^"]+)"/);
    const h = tag(/<meta property="og:image:height" content="([^"]+)"/);
    check('and the declared dimensions match the file',
          size && String(size.w) === w && String(size.h) === h,
          size ? size.w + 'x' + size.h + ' vs declared ' + w + 'x' + h : 'unreadable');
  }

  for (const t of ['og:title', 'og:description', 'og:url', 'og:type']) {
    check('the card declares ' + t, new RegExp('property="' + t + '"').test(idx));
  }
  check('the page has a description for search results too',
        /<meta name="description" content="[^"]{40,}"/.test(idx));
}

// ---------------------------------------------------------------- absolute urls
{
  // og:image and og:url are read by scrapers with no page context; a relative path
  // resolves against nothing and the card comes out blank.
  const rel = [];
  for (const m of idx.matchAll(/<meta property="og:(image|url)" content="([^"]+)"/g)) {
    if (!/^https?:\/\//.test(m[2])) rel.push('og:' + m[1] + ' = ' + m[2]);
  }
  check('the share tags use absolute URLs', rel.length === 0, rel.join(', '));
}

done();
