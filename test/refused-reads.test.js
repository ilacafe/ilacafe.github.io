// Every value listener, and whether a refusal reaches anybody.
//
// db.ref(p).on('value', cb) takes a THIRD argument — the cancel callback — and it is
// the only way a page hears that a read was refused. Without one, a refusal goes
// nowhere at all: the callback simply never fires, the variable it would have filled
// keeps whatever it was initialised to, and the page renders that. Usually {} or 0.
//
// This is not hypothetical. It took the café's analytics down twice in one day. Two
// changes added three nodes — orders/daily, pos/eodSummary, pos/eodSummaryBackfill —
// and merged without deploying the rules, which in this repo are deployed by hand. So
// every read of them was refused, and:
//
//   All time showed ₹999 instead of ₹1,70,919, because ROLLUPS stayed {} and DATA
//   held only today. Before the first sale of the day it would have shown ₹0.
//
//   The cash-up list showed no closings at all, because EOD stayed {} — a café that
//   has traded for eighteen months, reported as one that has never closed a day.
//
// Nothing on either screen looked broken. That is the whole problem: from a browser,
// a node nobody has heard of and a node nobody is allowed to read are the same event,
// and both are indistinguishable from a node that is legitimately empty.
//
// THE RULE IS NOT "EVERY LISTENER MUST HANDLE ITS REFUSAL". Some of these should
// simply fail loudly with the rest of the page, and a menu that will not load is
// visibly broken without any help. The rule is the one this repo already applies to
// whole-node reads next door in unbounded-reads.test.js: every one of them has been
// looked at, and A NEW ONE HAS TO BE LOOKED AT TOO, rather than arriving unremarked.
//
// WHAT THE LIST BELOW IS, HONESTLY. It is a debt ledger, not a clean bill of health.
// 76 of 81 listeners have no cancel callback and I have not reviewed them one by one;
// writing 76 confident justifications for code I had not each read would be the same
// carelessness that caused the outage. So they are pinned as unreviewed, and the set
// cannot grow. Working through them is a separate job, and the count here is the
// measure of how much of it is left.

const fs = require('fs');
const path = require('path');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Refused reads — every value listener accounted for');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'chef.html', 'barista.html', 'inventory.html'];

// Walk back from .on('value' to the start of the ref chain, so a listener is named by
// the path it listens to. A line number would move with every edit above it and make
// this list churn for no reason.
function pathOf(src, at) {
  let k = at, depth = 0;
  while (k > 0) {
    const c = src[k];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === ';' || c === '\n' || c === '{' || c === '}')) break;
    k--;
  }
  const seg = src.slice(k, at);
  const m = seg.match(/db\.ref\(\s*([^)]*)\)/) || seg.match(/ref\(\s*([^)]*)\)/);
  return m ? m[1].trim().replace(/\s+/g, ' ').slice(0, 60) : seg.trim().slice(-50);
}

function listeners(src) {
  const found = [];
  for (const m of src.matchAll(/\.on\(\s*['"]value['"]/g)) {
    const open = src.indexOf('(', m.index);
    let depth = 0, args = [], cur = '', k = open;
    for (; k < src.length; k++) {
      const c = src[k];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { depth--; if (depth === 0) { args.push(cur); break; } }
      if (depth === 1 && c === ',') { args.push(cur); cur = ''; }
      else if (depth >= 1 && !(depth === 1 && c === '(')) cur += c;
    }
    found.push({
      path: pathOf(src, m.index),
      handled: args.length >= 3 && !!args[2].trim(),
    });
  }
  return found;
}

// Reviewed, and answering a refusal on purpose. These are the ones where an empty
// render would be a lie about money or about what the café has done.
const HANDLED_ON_PURPOSE = {
  'analytics.html': "the cash-up list falls back to pos/eodArchive rather than showing no closings",
};

// Pinned, NOT cleared: no cancel callback, and not yet reviewed one by one. A refusal
// on any of these renders whatever the variable was initialised to. Counted per page
// so a new one is a failure and a fixed one is a visible decrease.
const UNREVIEWED = {
  'index.html': 10,
  'pos.html': 26,
  'admin.html': 20,
  'analytics.html': 10,
  'chef.html': 4,
  'barista.html': 3,
  'inventory.html': 3,
};

let total = 0, unhandled = 0;
const grew = [];
for (const page of PAGES) {
  const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const found = listeners(src);
  const bad = found.filter(f => !f.handled);
  total += found.length;
  unhandled += bad.length;
  const pinned = UNREVIEWED[page] || 0;
  // Counts are pinned, not identities, so this cannot say WHICH one is new — and
  // claiming it could would be a confident wrong answer of exactly the kind this
  // file exists to stop. It says what is unhandled and leaves the diff to the reader.
  if (bad.length > pinned) {
    grew.push(page + ': ' + bad.length + ' unhandled, ' + pinned + ' pinned. All ' +
              'unhandled here: ' + bad.map(b => b.path).join(', '));
  }
  check(page + ' adds no listener that swallows a refusal',
        bad.length <= pinned,
        grew[grew.length - 1] || '');
}

note('a listener with no cancel callback cannot report a refusal — it just never fires');

// The count only ever going down is the point of pinning it. A page that fixes one and
// adds one nets to zero above, so the totals are checked too.
const pinnedTotal = Object.values(UNREVIEWED).reduce((a, b) => a + b, 0);
check('the number of listeners that swallow a refusal has not grown',
      unhandled <= pinnedTotal,
      unhandled + ' unhandled against ' + pinnedTotal + ' pinned');
check('and every page is still accounted for',
      PAGES.every(p => p in UNREVIEWED),
      PAGES.filter(p => !(p in UNREVIEWED)).join(', '));

note(unhandled + ' of ' + total + ' listeners still swallow a refusal — pinned, not fixed');
note('lower a number in UNREVIEWED when you fix one; this fails if any page grows');
note(Object.keys(HANDLED_ON_PURPOSE).length + ' page(s) answer a refusal deliberately:');
for (const p in HANDLED_ON_PURPOSE) note('  ' + p + ' — ' + HANDLED_ON_PURPOSE[p]);

done();
