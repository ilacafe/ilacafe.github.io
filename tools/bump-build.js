#!/usr/bin/env node
// Move every page and build.json to a new build, in one step.
//
// Bumping this by hand went wrong once already: a regex with a numbered
// backreference met a replacement starting with a digit, `\1` became `\12`,
// and three pages were written with a corrupted line. The suites caught it
// before it reached main, but the fix is not to be more careful — it is to
// stop doing it by hand.
//
//   npm run bump            # 2026-08-26.2 -> 2026-08-26.3, or today's .1
//   npm run bump 2026-09-01.1
//
// Nothing here deploys. Commit the result; a push to main is the deploy.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD_JSON = path.join(ROOT, 'build.json');
const TAG = /(<script src="\/build-check\.js" data-build=")([^"]*)(")/;

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// Same day: next number. New day: start at .1. Anything unparseable: today's .1.
function next(current) {
  const m = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(String(current || ''));
  if (m && m[1] === today()) return m[1] + '.' + (Number(m[2]) + 1);
  return today() + '.1';
}

const asked = process.argv[2];
if (asked && !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(asked)) {
  console.error('A build looks like 2026-09-01.1 — got: ' + asked);
  process.exit(1);
}

const current = JSON.parse(fs.readFileSync(BUILD_JSON, 'utf8')).build;
const build = asked || next(current);

// Every page that loads the watcher, found rather than listed, so a new page
// added tomorrow is not silently left behind on an old build.
const pages = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.html'))
  .filter(f => TAG.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
  .sort();

if (!pages.length) {
  console.error('No page loads build-check.js — nothing to stamp, which is itself wrong.');
  process.exit(1);
}

for (const page of pages) {
  const file = path.join(ROOT, page);
  const src = fs.readFileSync(file, 'utf8');
  // Replace only inside the attribute, never by rewriting the line around it.
  fs.writeFileSync(file, src.replace(TAG, (_, open, __, close) => open + build + close));
  console.log('  ' + page);
}

fs.writeFileSync(BUILD_JSON, JSON.stringify({ build }) + '\n');
console.log('  build.json');
console.log('\n' + current + '  ->  ' + build + '\n');
console.log('Commit this with the change it describes. `npm test` fails if any of it drifts.');
