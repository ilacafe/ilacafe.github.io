// Settling a table must never lose an order that landed while the payment was
// being taken.
//
// This is the bug these tests exist for: payWithCash and settleUPI used to
// mutate this device's copy of the table and write the whole node back, so a
// round of drinks sent from another device between the checkout screen opening
// and the cashier tapping Cash was erased — already made, off the bill, table
// closed, no error anywhere. Scenario 3 is that exact sequence.
//
// The real settleTablePayment is driven against a simulated Realtime Database
// node reproducing Firebase's transaction semantics: the update function runs
// first against this device's cached value, and if the server has moved on it
// re-runs against the server's value, and only that second run commits.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const src = readPage('pos.html');
const sources = [
  'const LINE_EPS = 0.5;',
  extractFunction(src, 'lineTotal'),
  extractFunction(src, 'linePaid'),
  extractFunction(src, 'tableDue'),
  extractFunction(src, 'consumeSplitAllocation'),
  extractFunction(src, 'settleTablePayment'),
];

const PATH = 'pos/activeTables/4';
let server, local, onFirstPass, archived, forceError;

const clone = v => (v === null || v === undefined) ? v : JSON.parse(JSON.stringify(v));

function makeRef() {
  return {
    transaction(fn, cb) {
      if (forceError) { cb(new Error('permission denied'), false, null); return; }

      let input = clone(local[PATH]);
      let out = fn(input);

      // another device's write lands while this device was deciding
      if (onFirstPass) { onFirstPass(); onFirstPass = null; }

      if (out === undefined) { cb(null, false, { val: () => clone(server[PATH]) }); return; }

      // compare-and-set: did the value the decision was based on still hold?
      if (JSON.stringify(local[PATH]) !== JSON.stringify(server[PATH])) {
        input = clone(server[PATH]);
        out = fn(input);                       // this run is the one that commits
        if (out === undefined) { cb(null, false, { val: () => clone(server[PATH]) }); return; }
      }
      if (out === null) delete server[PATH]; else server[PATH] = clone(out);
      local[PATH] = clone(server[PATH]);
      cb(null, true, { val: () => clone(server[PATH]) });
    }
  };
}

const win = { pendingSplitAlloc: null, splitSel: {}, splitOther: 0 };
const API = buildModule(sources, {
  db: { ref: makeRef },
  archivePOSTable: (id, data, method) => archived.push({ id, data, method }),
  window: win,
  JSON, Math, parseFloat, parseInt, Object, console,
}, ['settleTablePayment', 'consumeSplitAllocation', 'tableDue']);

function reset(table) {
  server = {}; local = {}; archived = []; onFirstPass = null; forceError = false;
  if (table) { server[PATH] = clone(table); local[PATH] = clone(table); }
  win.pendingSplitAlloc = null; win.splitSel = {}; win.splitOther = 0;
}
const TABLE = () => ({
  total: 500, paid: 0, notes: '',
  items: { 'Latte (Regular)': { price: 250, qty: 2, base: 'Latte' } }
});

const { check, note, done } = suite('Settlement — transaction on the table node');

// ---- a plain, uncontested full payment
{
  reset(TABLE());
  let res;
  API.settleTablePayment('4', 500, 'Cash', { expectSettle: true }, r => { res = r; });
  check('full payment closes the table', res.closed === true);
  check('the table node is deleted', server[PATH] === undefined);
  check('archived exactly once', archived.length === 1, 'got ' + archived.length);
  check('the archive carries the items', archived[0].data.items['Latte (Regular)'].qty === 2);
  check('the archive records it paid in full', archived[0].data.paid === 500);
}

// ---- a part payment
{
  reset(TABLE());
  let res;
  API.settleTablePayment('4', 200, 'Cash', { expectSettle: false }, r => { res = r; });
  check('part payment keeps the table open', res.stillOpen === true && res.closed === false);
  check('the money is banked on the server', server[PATH].paid === 200, 'paid=' + server[PATH].paid);
  check('the remaining balance is reported', res.due === 300, 'due=' + res.due);
  check('nothing is archived', archived.length === 0);
  check('it is not flagged as grown', res.grew === false);
}

// ---- THE BUG: a round of drinks lands mid-payment
{
  reset(TABLE());
  onFirstPass = () => {                        // the other device's increment reaches the server
    server[PATH].total = 800;
    server[PATH].items['Flat White'] = { price: 300, qty: 1, base: 'Flat White' };
  };
  let res;
  API.settleTablePayment('4', 500, 'Cash', { expectSettle: true }, r => { res = r; });
  check('the table is NOT closed', res.closed === false);
  check('the table survives on the server', !!server[PATH]);
  check('the new drink survives', !!(server[PATH] && server[PATH].items['Flat White']),
        'items=' + Object.keys((server[PATH] || {}).items || {}).join(','));
  check('the original items survive', !!(server[PATH] && server[PATH].items['Latte (Regular)']));
  check('the payment is still banked', server[PATH].paid === 500, 'paid=' + server[PATH].paid);
  check('it reports 300 still due', res.due === 300, 'due=' + res.due);
  check('it is flagged as grown, so the cashier is told', res.grew === true);
  check('nothing is archived', archived.length === 0);
  note('the old whole-table write closed this table and filed a ₹500 bill for an ₹800 table');
}

// ---- two devices settling at once
{
  reset(TABLE());
  const results = [];
  onFirstPass = () => { delete server[PATH]; };    // the other cashier got there first
  API.settleTablePayment('4', 500, 'Cash', { expectSettle: true }, r => results.push(r));
  check('the loser does not archive a second bill', archived.length === 0, 'archived ' + archived.length);
  check('the loser reports aborted', results[0].aborted === true);
  check('the loser does not report closed', results[0].closed === false);
}

// ---- a split share allocates against the server's copy
{
  reset(TABLE());
  let res;
  API.settleTablePayment('4', 250, 'Cash',
    { alloc: { 'Latte (Regular)': 250 }, expectSettle: false }, r => { res = r; });
  check('the line records what was paid against it', server[PATH].items['Latte (Regular)'].paidAmt === 250,
        'paidAmt=' + server[PATH].items['Latte (Regular)'].paidAmt);
  check('the share counter increments', server[PATH].shares.paid === 1);
  check('the table total paid updates', server[PATH].paid === 250);
  check('the table stays open', res.stillOpen === true);
}

// ---- rounding must never strand a line a few paise short
{
  reset({ total: 333.33, paid: 0, items: { 'Chai': { price: 111.11, qty: 3 } } });
  API.settleTablePayment('4', 333.1, 'Cash', { alloc: { 'Chai': 333.1 } }, () => {});
  const it = (server[PATH] && server[PATH].items.Chai) || archived[0].data.items.Chai;
  check('a part-rupee shortfall closes the line', it.paidAmt === 333.33, 'paidAmt=' + it.paidAmt);
}

// ---- and never strand a whole bill either
{
  reset({ total: 500, paid: 499.7, items: { 'Latte': { price: 500, qty: 1 } } });
  let res;
  API.settleTablePayment('4', 0, 'Cash', { expectSettle: true }, r => { res = r; });
  check('a sub-rupee remainder counts as settled', res.closed === true);
}

// ---- a failed write is reported, never mistaken for a settled bill
{
  reset(TABLE());
  forceError = true;
  let res;
  API.settleTablePayment('4', 500, 'Cash', { expectSettle: true }, r => { res = r; });
  check('an error surfaces as failed', res.failed === true);
  check('an error is not reported as closed', res.closed === false);
  check('nothing is archived on error', archived.length === 0);
  note('the ledger entry is written before this point, so the money is on the books either way');
}

// ---- a tip rides on top of the bill, it does not pay the bill down
{
  reset(TABLE());
  let res;
  API.settleTablePayment('4', 400, 'UPI', { expectSettle: false }, r => { res = r; });
  check('only the bill portion pays the table down', server[PATH].paid === 400);
  check('the balance ignores the tip', res.due === 100, 'due=' + res.due);
}

// ---- local split state is handed over and cleared
{
  win.pendingSplitAlloc = { 'Latte': 100 };
  win.splitSel = { 'Latte': 100 };
  win.splitOther = 40;
  const alloc = API.consumeSplitAllocation();
  check('the allocation is handed to the transaction', alloc && alloc['Latte'] === 100);
  check('pendingSplitAlloc is cleared', win.pendingSplitAlloc === null);
  check('splitOther is cleared', win.splitOther === 0);
}

done();
