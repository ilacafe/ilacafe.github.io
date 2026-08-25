// Every page is one .html file with its JavaScript inline, and it deploys
// straight to a live counter with no build step in between. A syntax error
// therefore reaches a till, and reaches it silently — the browser stops at the
// broken statement and the rest of the page never wires up.
//
// This is the cheapest useful check in the repo: parse every inline <script>
// in every page, and the service worker.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Syntax — every page parses');

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();

for (const page of pages) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  if (!blocks.length) { check(page + ' — no inline script', true); continue; }

  let err = null;
  blocks.forEach((code, i) => {
    if (err) return;
    try { new vm.Script(code, { filename: page + ' [inline script ' + (i + 1) + ']' }); }
    catch (e) { err = e.message; }
  });
  check(page + ' — ' + blocks.length + ' inline script block(s) parse', err === null, err);
}

for (const script of fs.readdirSync(ROOT).filter(f => f.endsWith('.js')).sort()) {
  let err = null;
  try { new vm.Script(fs.readFileSync(path.join(ROOT, script), 'utf8'), { filename: script }); }
  catch (e) { err = e.message; }
  check(script + ' parses', err === null, err);
}

note('parse only — this cannot catch a runtime error, just a page that never starts');

done();
