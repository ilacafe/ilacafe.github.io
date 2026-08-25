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
