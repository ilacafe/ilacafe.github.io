// The prep and delivery log: written since the page was first built, and until now
// displayed nowhere. Stock going wrong is diagnosed by looking at what was logged —
// who prepped what, who received which delivery, how much came off the shelf — and
// none of that was reachable from any page in the repo.
//
// The write itself has since moved into the Worker, because the PIN in front of it
// was advice twice over: the prompt ran in a browser the person filling it in
// controls, AND inventory was writable by any staff role, so the write did not need
// the prompt at all. The page reads the log; the robot is the only thing that writes
// it. The properties below did not go away with the move, so they are asked of
// whichever component is answerable for each of them now.

const fs = require('fs');
const path = require('path');
const { ROOT, readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Inventory log — written, and now readable');

const src = readPage('inventory.html');

// ---------------------------------------------------------------- the key cannot collide
{
  const worker = fs.readFileSync(path.join(ROOT, 'worker', 'worker.js'), 'utf8');
  const block = worker.slice(worker.indexOf('async function handleInventoryLog'));

  // This was the one write in the codebase keyed on a bare Date.now(): two tablets
  // confirming in the same millisecond wrote the same path and one entry silently
  // replaced the other. It kept randomness on the way through the Worker.
  const key = /const key = 'inv-' \+ now \+ '-' \+ Math\.random\(\)/.test(block);
  check('a log entry key still carries more than the clock', key,
        'a millisecond is not unique across two tablets, or across a skewed one');

  check('the key sorts by time as well', /'inv-' \+ now/.test(block),
        'the fixed-width millisecond has to come first or the node stops being browsable');

  check('and the record carries a numeric timestamp of its own',
        /entry\.at = now;/.test(block),
        'toLocaleString() is unsortable and reads differently on every device');

  check('the page does not write the log at all any more',
        !/db\.ref\(\)\.update|inventory\/logs\/|inventory\/stock\//.test(src),
        'the rules refuse it from there; a write left here would just fail');
  note('the page asks the Worker, which is the only thing the rules let write these');
}

// ------------------------------------------------- and the tablet holds no secrets
{
  // A consequence worth checking, not just a tidy-up. This tablet used to download
  // every staff PIN hash in the café and carry the salt in its own source, to answer
  // a question it was never the right place to answer.
  check('the stock tablet no longer holds the staff PIN hashes',
        !/db\.ref\('staff'\)/.test(src), 'it downloaded every one of them');
  check('nor the salt they are hashed with', !/PIN_SALT/.test(src));
  check('nor the recipes it used to compute deductions from',
        !/db\.ref\('inventory\/recipes'\)/.test(src),
        'a client that computes its own deductions can under-report what a batch used');
  note('the Worker reads the recipe when it logs the batch');
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
