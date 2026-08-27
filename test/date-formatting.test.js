// Formatting a date is not free, and these pages do it per order and per second.
//
// `d.toLocaleDateString('en-GB', {day:'2-digit', month:'short'})` reads as a
// cheap string operation. It is not: passing an options object constructs a fresh
// Intl.DateTimeFormat on every call, and the engine's own caching does not save
// you. Measured on this machine, 64µs a call against 2µs for a formatter that
// already exists — a factor of thirty, for the same string.
//
// That mattered in exactly two places, and both are the shape where it stings:
//
//   analytics.html called it once per order while aggregating a range. On an
//   'All time' view over twenty thousand orders that was ~1.3 SECONDS of the
//   main thread, and render() runs again on every range button and every
//   database update. It is the owner's phone that freezes.
//
//   chef.html and barista.html called it once a second, for as long as the
//   screen is open, which is all day. Skipping the DOM write when the minute has
//   not changed was only half the fix: the string still had to be built to find
//   that out.
//
// So this suite pins the thing that is easy to undo by accident — that the
// formatter is built once rather than per call — and pins it by COUNTING
// constructions rather than by timing anything, because a timing assertion on a
// shared CI runner is a flake waiting to happen.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Date formatting — the formatter is built once');

// ---------------------------------------------------------------- analytics
{
  const src = readPage('analytics.html');

  // Two stand-ins, because there are two ways to reach the slow path and counting
  // only one of them is how this suite first passed against the very code it was
  // written to reject. Constructing Intl.DateTimeFormat per call is the obvious
  // one. The original spelling never mentions Intl at all — it goes through
  // Date.prototype.toLocaleDateString, which builds the same formatter internally
  // and out of sight. Both are counted.
  let built = 0, viaDate = 0;
  const CountingIntl = {
    DateTimeFormat: function (loc, opts) {
      built++;
      return new Intl.DateTimeFormat(loc, opts);
    }
  };
  class CountingDate extends Date {
    toLocaleDateString(loc, opts) { if (opts) viaDate++; return super.toLocaleDateString(loc, opts); }
    toLocaleTimeString(loc, opts) { if (opts) viaDate++; return super.toLocaleTimeString(loc, opts); }
    toLocaleString(loc, opts)     { if (opts) viaDate++; return super.toLocaleString(loc, opts); }
  }
  const mod = buildModule([extractFunction(src, 'bucketKey')],
                          { Intl: CountingIntl, Date: CountingDate, String }, ['bucketKey']);

  const base = Date.UTC(2024, 0, 1);
  const stamps = [];
  for (let i = 0; i < 500; i++) stamps.push(base + i * 3600000 * 7);

  built = 0; viaDate = 0;
  for (const unit of ['hour', 'day', 'month']) for (const ts of stamps) mod.bucketKey(ts, unit);
  const calls = stamps.length * 3;

  check('bucketKey builds a handful of formatters, not one per order',
        built <= 3, built + ' built across ' + calls + ' calls');
  note('one per bucket unit is the intent; one per call is the bug this replaced');

  check('and never takes the toLocale-with-options shortcut back to per-call',
        viaDate === 0, viaDate + ' of ' + calls + ' calls went through Date.prototype with options');

  // Building it once is only right if it still says the same thing. This is the
  // exact expression each branch replaced, so a "tidy-up" that changes the
  // rendered label — and with it every bucket key the trend chart groups on —
  // cannot pass.
  const ref = (ts, unit) => {
    const d = new Date(ts);
    if (unit === 'hour') return d.toLocaleDateString('en-GB', {day:'2-digit', month:'short'}) +
                                ' ' + String(d.getHours()).padStart(2, '0') + 'h';
    if (unit === 'day') return d.toLocaleDateString('en-GB', {day:'2-digit', month:'short'});
    return d.toLocaleDateString('en-GB', {month:'short', year:'2-digit'});
  };
  let wrong = 0, example = '';
  for (const unit of ['hour', 'day', 'month']) for (const ts of stamps) {
    const a = ref(ts, unit), b = mod.bucketKey(ts, unit);
    if (a !== b && !wrong++) example = unit + ': ' + a + ' !== ' + b;
  }
  check('and still formats every bucket exactly as it did before', wrong === 0, example);
}

// ------------------------------------------------------------ kitchen screens
// Source-level, because what matters is where the formatter is built rather than
// what it returns: inside the once-a-second callback is the bug, outside it is
// the fix, and both produce identical clocks.
{
  const offenders = [];
  for (const page of ['chef.html', 'barista.html']) {
    const src = readPage(page).replace(/<!--[\s\S]*?-->/g, '');
    const at = src.indexOf('setInterval(');
    const body = at < 0 ? '' : src.slice(at, src.indexOf('}, 1000);', at));
    if (!body) { offenders.push(page + ': could not find the one-second interval'); continue; }
    if (/toLocale\w*\([^)]*\{/.test(body)) offenders.push(page + ': builds a formatter every second');
  }
  check('neither kitchen screen builds a formatter inside its one-second loop',
        offenders.length === 0, offenders.join(', '));
  note('the screens run open-to-close, so a per-second cost is paid ~30,000 times a service');
}

done();
