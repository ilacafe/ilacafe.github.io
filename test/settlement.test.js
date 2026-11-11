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
  extractFunction(src, 'closedElsewhere'),
];

const PATH = 'pos/activeTables/4';
let server, local, onFirstPass, archived, forceError, cut;

const clone = v => (v === null || v === undefined) ? v : JSON.parse(JSON.stringify(v));

function makeRef() {
  return {
    transaction(fn, cb) {
      if (forceError) { cb(new Error('permission denied'), false, null); return; }

      // The wifi blinks with the payment in the air. The SDK cancels a transaction it
      // has sent and not heard back about, with Error('disconnect') — and that error is
      // the same whether the server applied the write ('landed') or never saw it
      // ('lost'). Each entry in `cut` spends one attempt.
      if (cut && cut.length) {
        const how = cut.shift();
        const out0 = fn(clone(local[PATH]));
        if (how === 'landed' && out0 !== undefined) {
          if (out0 === null) delete server[PATH]; else server[PATH] = clone(out0);
        }
        local[PATH] = clone(server[PATH]);       // what the till sees once it is back
        cb(new Error('disconnect'), false, null);
        return;
      }

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
  server = {}; local = {}; archived = []; onFirstPass = null; forceError = false; cut = null;
  win.pastBills = [];
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
  note('the ledger line is written only once the table has taken the payment, so nothing is on the books');
}

// ---- a tip rides on top of the bill, it does not pay the bill down
{
  reset(TABLE());
  let res;
  API.settleTablePayment('4', 400, 'UPI', { expectSettle: false }, r => { res = r; });
  check('only the bill portion pays the table down', server[PATH].paid === 400);
  check('the balance ignores the tip', res.due === 100, 'due=' + res.due);
}

// ---- every payment is stamped onto the table it paid
{
  reset(TABLE());
  API.settleTablePayment('4', 200, 'Cash', { expectSettle: false }, () => {});
  const pays = server[PATH]._pays || {};
  check('a payment leaves its own id on the table, against what it paid',
        Object.keys(pays).length === 1 && Object.values(pays)[0] === 200, JSON.stringify(pays));
  note('that stamp is what makes sending the same payment again safe');
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

// =========================================================== the wifi blinks
//
// A payment in flight when the connection is cut comes back as an error that cannot
// say whether the server applied it. The table transaction is made again, and what
// has to hold is that the payment ends up on the table — and reported — exactly once,
// whichever way the first attempt went.
const settle = (amount, opts) => new Promise(resolve => {
  let unsure = 0;
  API.settleTablePayment('4', amount, 'Cash',
    Object.assign({ onUnsure: () => { unsure++; } }, opts || {}),
    r => resolve({ res: r, unsure }));
});

(async () => {
  // ---- a part payment that landed, and was reported as an error
  {
    reset(TABLE()); cut = ['landed'];
    const { res, unsure } = await settle(200, { expectSettle: false });
    check('a part payment cut off AFTER it landed is found on the table, not added again',
          server[PATH].paid === 200, 'paid=' + server[PATH].paid);
    note('added again, the table would read ₹400 paid for ₹200 taken');
    check('and is reported as taken, so its ledger line is written', res.stillOpen === true && res.failed === false, JSON.stringify(res));
    check('the share is counted once', server[PATH].shares.paid === 1, 'shares.paid=' + server[PATH].shares.paid);
    check('and the cashier was told the till was checking', unsure === 1 && res.retried === true, 'onUnsure x' + unsure);
  }

  // ---- a part payment that never arrived
  {
    reset(TABLE()); cut = ['lost'];
    const { res } = await settle(200, { expectSettle: false });
    check('a part payment cut off BEFORE it landed is made again, once',
          server[PATH].paid === 200 && res.stillOpen === true, 'paid=' + server[PATH].paid);
  }

  // ---- the payment that closes the table, landed and unheard
  {
    reset(TABLE()); cut = ['landed'];
    const { res } = await settle(500, { expectSettle: true });
    check('a closing payment cut off after it landed is recognised as the one that closed the table',
          res.closed === true && res.aborted === false, JSON.stringify(res));
    note('"another till closed it — not recorded" here is a sale with no ledger line and no bill');
    check('and the bill it closed is archived, once', archived.length === 1 && archived[0].data.total === 500, archived.length + ' archived');
    check('with the table gone', server[PATH] === undefined);
  }

  // ---- the same, but the OTHER till closed it while this one was cut off
  {
    reset(TABLE()); cut = ['lost'];
    // this till's attempt never arrived; in the meantime the other till took the money,
    // closed the table and wrote its bill
    onFirstPass = null;
    const p = settle(500, { expectSettle: true });
    delete server[PATH]; local[PATH] = undefined;
    win.pastBills = [{ id: Date.now(), table: 'Table 4', total: 500 }];
    const { res } = await p;
    check('a table the other till closed in the meantime is not claimed as this till’s close',
          res.aborted === true && res.closed === false, JSON.stringify(res));
    check('and nothing is archived a second time', archived.length === 0, archived.length + ' archived');
  }

  // ---- cut off twice, then through
  {
    reset(TABLE()); cut = ['lost', 'landed'];
    const { res } = await settle(500, { expectSettle: true });
    check('a payment cut off more than once still ends as one close',
          res.closed === true && archived.length === 1, JSON.stringify(res) + ' / ' + archived.length + ' archived');
  }

  // ---- refused is not "try again"
  {
    reset(TABLE()); forceError = true;
    const { res, unsure } = await settle(500, { expectSettle: true });
    check('a write the rules refuse is not retried', res.failed === true && unsure === 0 && !res.unsure, JSON.stringify(res));
  }

  done();
})();
