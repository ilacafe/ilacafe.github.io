// One DONE tap, however many times the button is pressed.
//
// A kitchen ticket's DONE button used to read the order and act on whatever it
// read. The card only fades once that read comes back, so on a slow connection it
// is still on screen and still tappable — and two taps both found the order and
// both did everything: two pushes to orders/ready, and stationsDone incremented
// twice on the customer's tracking record.
//
// That second increment is the one that costs. A split order carries stations: 2,
// and the tracker flips to "ready" the moment stationsDone reaches it. So two taps
// at the chef's screen told a customer their whole order was ready while the bar
// had not started the drinks.
//
// Two screens open on the same station is the same story without the slow
// connection, which is why the fix is a lock on the node rather than on the
// button. Both kitchen pages are checked — they carry the same code, and a fix
// applied to one of them is the failure this suite exists to catch.

const { readPage, extractAssignedFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Kitchen DONE — one tap, one ticket');

const clone = v => (v === null || v === undefined) ? v : JSON.parse(JSON.stringify(v));

// Firebase's transaction semantics, as settlement.test.js models them: the update
// function runs against this device's cached value, and re-runs against the
// server's if the two have diverged. Returning undefined aborts.
function makeDb(state, log) {
  const node = (path) => ({
    transaction(fn, cb) {
      const before = clone(state[path]);
      const out = fn(clone(before));
      if (out === undefined) { if (cb) cb(null, false, snap(state[path])); return Promise.resolve({ committed: false, snapshot: snap(state[path]) }); }
      if (out === null) delete state[path]; else state[path] = clone(out);
      if (cb) cb(null, true, snap(state[path]));
      return Promise.resolve({ committed: true, snapshot: snap(state[path]) });
    },
    set(v) { log.push({ op: 'set', path, value: clone(v) }); state[path] = clone(v); return Promise.resolve(); },
    push(v) { log.push({ op: 'push', path, value: clone(v) }); return { key: '-N' + log.length }; },
    remove() { log.push({ op: 'remove', path }); delete state[path]; return Promise.resolve(); },
    once(_e) { return Promise.resolve(snap(state[path])); }
  });
  const snap = (v) => ({ val: () => clone(v === undefined ? null : v), exists: () => v != null });
  return { ref: node };
}

const ACTIVE = (station) => 'orders/active/' + station + '/o1';
const TRACK = 'orders/track/tk1';

// A split order: the food is here, the drinks are at the other station.
const ORDER = () => ({
  destination: 'Table 6', time: '19:40', source: 'POS', trackId: 'tk1',
  items: { 'Margherita': { qty: 1, price: 400 } }
});
const TRACKED = () => ({ status: 'preparing', stations: 2, stationsDone: 0 });

(async () => {

for (const [page, station] of [['chef.html', 'chef'], ['barista.html', 'barista']]) {
  const src = readPage(page);
  const source = extractAssignedFunction(src, 'markOrderDone');

  // Every tap is let run to completion before the next is counted. The old shape
  // did its work in a .then(), so without this the suite would fail against it for
  // the wrong reason — nothing having happened yet, rather than happening twice.
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const run = async (taps) => {
    const state = { [ACTIVE(station)]: ORDER(), [TRACK]: TRACKED() };
    const log = [];
    const timers = [];
    const api = buildModule([source], {
      db: makeDb(state, log),
      document: { getElementById: () => null },
      setTimeout: (fn) => { timers.push(fn); },
      Date, JSON, Object, console, Promise,
    }, ['markOrderDone']);
    for (let i = 0; i < taps; i++) { api.markOrderDone('o1'); await settle(); }
    timers.forEach(fn => fn());          // the 200ms removal
    await settle();
    return { state, log };
  };

  const one = await run(1);
  check(page + ' — one tap rings the counter once',
        one.log.filter(l => l.op === 'push' && l.path === 'orders/ready').length === 1,
        JSON.stringify(one.log.filter(l => l.path === 'orders/ready')));
  check(page + ' — one tap records the order as completed',
        one.log.some(l => l.op === 'set' && l.path === 'orders/completed/' + station + '/o1'));
  check(page + ' — one tap counts this station done, once',
        one.state[TRACK].stationsDone === 1, JSON.stringify(one.state[TRACK]));
  check(page + ' — and does not tell the customer a split order is ready',
        one.state[TRACK].status === 'preparing', one.state[TRACK].status);
  check(page + ' — the ticket leaves the board', one.log.some(l => l.op === 'remove'));

  const two = await run(2);
  check(page + ' — a second tap rings the counter no further times',
        two.log.filter(l => l.op === 'push' && l.path === 'orders/ready').length === 1,
        two.log.filter(l => l.path === 'orders/ready').length + ' ready signal(s)');
  check(page + ' — and does not count this station twice',
        two.state[TRACK].stationsDone === 1, 'stationsDone ' + two.state[TRACK].stationsDone);
  check(page + ' — so the drinks are still what the customer is waiting for',
        two.state[TRACK].status === 'preparing', two.state[TRACK].status);

  const many = await run(5);
  check(page + ' — five taps are still one ticket',
        many.log.filter(l => l.op === 'push' && l.path === 'orders/ready').length === 1 &&
        many.state[TRACK].stationsDone === 1,
        many.log.filter(l => l.path === 'orders/ready').length + ' signals, stationsDone ' +
        many.state[TRACK].stationsDone);
  note(page + ' — the same tap arriving from a second screen takes the same path');
}

// The other half of the pair still has to finish it.
{
  const settleAll = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const state = {};
  const log = [];
  const timers = [];
  for (const [page, station] of [['chef.html', 'chef'], ['barista.html', 'barista']]) {
    state[ACTIVE(station)] = ORDER();
  }
  state[TRACK] = TRACKED();
  for (const [page, station] of [['chef.html', 'chef'], ['barista.html', 'barista']]) {
    const api = buildModule([extractAssignedFunction(readPage(page), 'markOrderDone')], {
      db: makeDb(state, log), document: { getElementById: () => null },
      setTimeout: (fn) => { timers.push(fn); }, Date, JSON, Object, console, Promise,
    }, ['markOrderDone']);
    api.markOrderDone('o1'); await settleAll();
    api.markOrderDone('o1'); await settleAll();   // both stations double-tapped
  }
  timers.forEach(fn => fn());
  await settleAll();
  check('both stations done — twice each — is still exactly two',
        state[TRACK].stationsDone === 2, 'stationsDone ' + state[TRACK].stationsDone);
  check('and only then does the customer hear it is ready',
        state[TRACK].status === 'ready', state[TRACK].status);
  note('the lock is per station, so it cannot swallow the other one');
}

done();

})();
