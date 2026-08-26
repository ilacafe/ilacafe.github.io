// The prep and delivery log: written since the page was first built, and until now
// displayed nowhere. Stock going wrong is diagnosed by looking at what was logged —
// who prepped what, who received which delivery, how much came off the shelf — and
// none of that was reachable from any page in the repo.
//
// It is also the one write in the codebase that keyed a record on a bare
// Date.now(). pos.html appends randomness to its archive keys for exactly this
// reason; this one did not.

const fs = require('fs');
const path = require('path');
const { ROOT, readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Inventory log — written, and now readable');

const src = readPage('inventory.html');

// ---------------------------------------------------------------- the key cannot collide
{
  check('a log entry is keyed by push(), not by the clock',
        /const logKey = db\.ref\('inventory\/logs'\)\.push\(\)\.key/.test(src),
        'two tablets confirming in the same millisecond wrote the same path, ' +
        'and one entry silently replaced the other');

  check('and nothing still writes a bare timestamp key',
        !/inventory\/logs\/\$\{timestamp\}/.test(src),
        'a device with a skewed clock can land on a key that already exists');

  // The key is no longer the time, so the time has to be in the record.
  const writes = (src.match(/updates\[`inventory\/logs\/\$\{logKey\}`\]/g) || []).length;
  const stamped = (src.match(/at: timestamp/g) || []).length;
  check('every log write carries a numeric timestamp of its own',
        writes > 0 && writes === stamped,
        writes + ' writes, ' + stamped + ' with `at`');
  note('toLocaleString() is unsortable and reads differently on every device');
}

// ---------------------------------------------------------------- the read is bounded
{
  check('the log tab reads a bounded slice, not the whole node',
        /db\.ref\('inventory\/logs'\)\.limitToLast\(\d+\)/.test(src),
        'this node only ever grows — an unbounded read gets slower every week');

  check('and there is somewhere for it to render',
        /id="tab-log"/.test(src) && /id="log-list"/.test(src));
}

// ---------------------------------------------------------------- newest first, on purpose
{
  const api = buildModule(
    [extractFunction(src, 'logAt')], { Number }, ['logAt']);

  check('a row with `at` is dated by it', api.logAt('-Nabc', { at: 1700 }) === 1700);
  check('a row written before `at` existed falls back to its key',
        api.logAt('1756000000000', {}) === 1756000000000,
        'those keys were the timestamp, so the information is still there');
  check('a push key with no `at` sorts last rather than throwing',
        api.logAt('-Nabc', {}) === 0);
  check('and junk does not become a date',
        api.logAt('-Nabc', { at: 'yesterday' }) === 0);

  // Two kinds of key live in this node — millisecond timestamps from before the
  // change and push IDs after it. Firebase collates integer-like keys ahead of
  // string ones, so the order that comes back is right; but a log that quietly
  // lists itself backwards is not worth resting on that.
  check('the page sorts on the number rather than trusting key order',
        /rows\.sort\(\(a, b\) => b\.at - a\.at\)/.test(src),
        'ordering would otherwise depend on Firebase collation rules');
  note('verified in a browser under both key orders — newest first either way');
}

// Whether a staff name can become markup is a question about what the browser does
// with it, not about what the source looks like. A source scan for `escapeHTML(`
// flags `v.deductions ? ...` as a hole and misses `(v.staff || 'x')` as one — it
// was wrong in both directions when tried. inventory-browser.test.js renders a row
// built to break out and checks that nothing executed.

done();
