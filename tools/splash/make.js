#!/usr/bin/env node
// The iOS launch screen, which is otherwise black.
//
//   node tools/splash/make.js        writes splash/*.png, prints the <link> tags
//
// An installed home-screen web app on iOS shows a launch image while the page loads.
// Android builds one from the manifest's background_color and icon; iOS does not — it
// wants apple-touch-startup-image, one per device size and orientation, and with none
// present it shows black. With black-translucent as the status bar style, very black.
//
// So every one of the seven apps opened onto a black rectangle for as long as startup
// took, and "black screen then the app" is what the café called it. Startup being
// quicker is a separate job and mostly done; this is about what is on screen WHILE it
// happens, which should be the café rather than nothing.
//
// Rendered rather than drawn by hand, because there are two dozen of them and Apple
// adds sizes every autumn: a new iPhone is a line in DEVICES and a re-run, not a
// morning in an image editor. Flat brand colour with the logo centred, which is what
// the app itself opens to, so the splash and the first paint are the same picture and
// the join does not show.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'splash');
const BRAND = '#8D6E52';

// CSS width, CSS height (portrait), device pixel ratio. Portrait dimensions even for
// the landscape file — that is how iOS reads the media query; only `orientation`
// changes, and the image itself is turned on its side.
const DEVICES = [
  // iPhone
  [320, 568, 2, 'phone'], [375, 667, 2, 'phone'], [414, 736, 3, 'phone'],
  [375, 812, 3, 'phone'], [414, 896, 2, 'phone'], [414, 896, 3, 'phone'],
  [390, 844, 3, 'phone'], [393, 852, 3, 'phone'], [402, 874, 3, 'phone'],
  [428, 926, 3, 'phone'], [430, 932, 3, 'phone'], [440, 956, 3, 'phone'],
  // iPad — these get a landscape file too: a kitchen display is not held upright
  [744, 1133, 2, 'pad'], [768, 1024, 2, 'pad'], [810, 1080, 2, 'pad'],
  [820, 1180, 2, 'pad'], [834, 1112, 2, 'pad'], [834, 1194, 2, 'pad'],
  [1024, 1366, 2, 'pad'],
  // The M4 iPad Pros, which changed size. THIS IS WHY THE FIRST VERSION OF THIS DID
  // NOTHING: the café runs recent iPad Pros, neither of these was in the list, nothing
  // matched, and iOS fell straight back to black — exactly as if none of it had
  // shipped. A missing size and a broken feature look identical from the floor.
  [834, 1210, 2, 'pad'],                 // iPad Pro 11" (M4)
  [1032, 1376, 2, 'pad'],                // iPad Pro 13" (M4)
];

const page = (w, h, logo) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${w}px;height:${h}px;background:${BRAND};overflow:hidden}
  .wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
  img{width:${Math.round(Math.min(w, h) * 0.34)}px;height:auto;display:block}
</style></head><body><div class="wrap"><img src="${logo}"></div></body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // NOT logo.png, and not icon.png either.
  //
  // logo.png is a 1200x427 canvas with a small mark and a great deal of clear space in
  // it; sized to fit that canvas the mark came out about a fifth of the size intended,
  // which is how the first run of this looked. icon.png is the mark itself but only
  // 200px, so on a phone at three device pixels per CSS pixel it is soft.
  //
  // One shared mark rather than each app's own, which would be six sets and a hundred
  // and fifty files for a difference nobody sees in the half second it is up.
  const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'icon-customer.png')).toString('base64');
  const browser = await chromium.launch(
    fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const links = [];
  let bytes = 0;

  for (const [w, h, r, kind] of DEVICES) {
    const orientations = kind === 'pad'
      ? [['portrait', w, h], ['landscape', h, w]]
      : [['portrait', w, h]];
    for (const [orient, cw, ch] of orientations) {
      const ctx = await browser.newContext({ viewport: { width: cw, height: ch }, deviceScaleFactor: r });
      const tab = await ctx.newPage();
      await tab.setContent(page(cw, ch, logo), { waitUntil: 'load' });
      const file = `${w}x${h}@${r}-${orient}.png`;
      const buf = await tab.screenshot({ type: 'png' });
      fs.writeFileSync(path.join(OUT, file), buf);
      bytes += buf.length;
      await ctx.close();
      links.push(`    <link rel="apple-touch-startup-image" href="/splash/${file}" ` +
                 `media="(device-width: ${w}px) and (device-height: ${h}px) and ` +
                 `(-webkit-device-pixel-ratio: ${r}) and (orientation: ${orient})">`);
    }
  }
  // AND ONE WITH NO MEDIA QUERY AT ALL, WHICH IS THE POINT.
  //
  // Everything above is an exact match against a device that existed when it was
  // written, and Apple ships new sizes every year. The first version of this had no
  // fallback, so the café's iPad Pros matched nothing and got the black screen the
  // whole exercise was about — and there was no way to tell that apart from the tags
  // never having been added.
  //
  // iOS takes an un-queried apple-touch-startup-image when no queried one matches, and
  // scales it. Scaled is not ideal; it is a flat brand colour with a mark in the middle,
  // so scaled is fine. What it buys is that an unknown device is never black again,
  // which matters more than the pixels.
  //
  // Generated at the largest size in the list so it is never scaled UP, and its LINK
  // is emitted after all the queried ones. Among links whose media query matches, order
  // decides, and an un-queried one matches everything — first in the list it could
  // shadow every exact match on a browser that takes the first hit. Last, an exact match
  // wins wherever there is one and this catches the rest. Neither order can produce a
  // black screen, which is the property that matters; this order also keeps the pixels
  // right on the devices that are named.
  {
    const [fw, fh] = [1032, 1376], r = 2;
    const ctx = await browser.newContext({ viewport: { width: fw, height: fh }, deviceScaleFactor: r });
    const tab = await ctx.newPage();
    await tab.setContent(page(fw, fh, logo), { waitUntil: 'load' });
    const buf = await tab.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(OUT, 'fallback.png'), buf);
    bytes += buf.length;
    await ctx.close();
  }

  links.push('    <link rel="apple-touch-startup-image" href="/splash/fallback.png">');

  await browser.close();
  // Tags to stdout, progress to stderr, so the useful half can be piped or pasted
  // without a generated file sitting in the repo going quietly out of date.
  console.log(links.join('\n'));
  console.error(links.length + ' images, ' + (bytes / 1024).toFixed(0) + 'KB total');
  console.error('the <link> tags above go in each page\'s head — test/splash.test.js checks all seven have them');
})();
