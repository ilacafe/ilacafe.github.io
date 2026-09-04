// What the till shows somebody who is not allowed to see the cash-up.
//
// The ledger is the counter's and the owner's — three tiers, on purpose, and the
// rules enforce it. What went wrong was not the rule. A member of staff opened the
// POS on their phone, the page loaded, the tables and the bills worked, and the
// cash-up said "No logs."
//
// It said that because a refused read in Realtime Database is not an error. The
// success callback simply never fires, window.salesLedger stays empty, and empty is
// drawn as a quiet morning. Nobody at the counter could tell the difference, and
// nobody looking at the code could either — it took a shift on an Android phone.
//
// So the page has to catch the refusal and say which one it is.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('The cash-up somebody is not allowed to see');

const src = readPage('pos.html');

// ------------------------------------------------------ the listener asks to know
{
  // .on('value', ok, cancel) — without the third argument a refusal is silent, and
  // silence is what this whole suite is about.
  const listener = /db\.ref\('pos\/ledgerEntries'\)\.on\('value',[\s\S]{0,2000}?\n            \}\);/.exec(src);
  check('the ledger listener exists', !!listener);
  check('and it passes a cancel callback, so a refusal is not silent',
        !!listener && /\}, \(\) => \{/.test(listener[0]),
        'two-argument .on() drops permission_denied on the floor');
  check('which records that it was refused rather than that there was nothing',
        !!listener && /window\.ledgerDenied = true;/.test(listener[0]));
  check('and a read that succeeds clears it again',
        !!listener && /window\.ledgerDenied = false;/.test(listener[0]),
        'otherwise a cashier who reconnects keeps the refusal message forever');
  note('the same gate covers pos/unverified, which nothing renders directly');
  const carry = /db\.ref\('pos\/unverified'\)\.on\(([\s\S]{0,600}?)\}\);/.exec(src);
  check('pos/unverified passes a cancel callback too', !!carry);
  check('and treats a refusal as nothing to carry',
        !!carry && /\}, \(\) => \{ window\._carryUnverified = \{\};/.test(carry[1]));

  // A REFUSAL IS STILL AN ANSWER, AND THE RECONCILER WAITS FOR ONE.
  //
  // reconcileLedgerVerification refuses to run until pos/unverified has answered,
  // because an empty carry map that has not been read is not an empty one — a credit
  // a parked row already owns would read as free and settle a second sale. So the
  // refusal path has to set the same flag the success path does. If it does not, a
  // cashier whose read of this node is refused gets a reconciler that never runs
  // again, and the failure is the quiet kind: unverified lines simply stop verifying.
  check('and a refusal still counts as having answered',
        !!carry && /\}, \(\) => \{ window\._carryUnverified = \{\}; window\._carryKnown = true;/.test(carry[1]),
        'a refused read that never sets _carryKnown stalls the reconciler for good');
  check('as does a read that comes back',
        !!carry && /window\._carryKnown = true;[\s\S]{0,120}reconcileLedgerVerification/.test(carry[1]),
        'the flag has to be set before the pass it gates');
}

// ------------------------------------------------------------- and it says which
{
  const boxes = {};
  const document = {
    getElementById: (id) => (boxes[id] = boxes[id] || { innerHTML: '', classList: { contains: () => true } }),
  };
  const api = buildModule([extractFunction(src, 'renderLedger')],
    { document, window: global, Math, Date, Object, parseInt, parseFloat, String,
      escapeHTML: (x) => String(x == null ? '' : x) },
    ['renderLedger']);

  // refused
  global.ledgerDenied = true;
  global.salesLedger = [];
  api.renderLedger();
  const refused = boxes['ledger-list'].innerHTML;
  check('a refused cash-up does not claim there are no logs', !/No logs/.test(refused), refused);
  check('it says who the cash-up is for', /counter and the owner/i.test(refused), refused);
  check('and what to do about it', /cashier access/i.test(refused), refused);
  note('"No logs." on a busy Saturday is the least useful true-looking sentence there is');

  // genuinely empty, for somebody who IS allowed to see it
  global.ledgerDenied = false;
  global.salesLedger = [];
  api.renderLedger();
  check('and a cashier on a quiet morning still gets "No logs."',
        /No logs/.test(boxes['ledger-list'].innerHTML), boxes['ledger-list'].innerHTML);
  note('the two states have to look different, which was the entire problem');
}

done();
