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

  // ------------------------------------------------------- one label, not two
  //
  // A void, a refund and a write-off are written with their label already on the
  // front of the reason — 'VOID: Table 4 — wrong order (Asha)' — so the archive and
  // the owner's report read on their own. The cash-up put its own tag in front of
  // that, and every one of them read "VOID: VOID: Table 4 …".
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const real = buildModule([extractFunction(src, 'renderLedger')],
    { document, window: global, Math, Date, Object, parseInt, parseFloat, String, escapeHTML: esc },
    ['renderLedger']);
  global.salesLedger = [
    { type: 'void_cash', amount: -240, reason: 'VOID: Table 4 \u2014 wrong order (Asha)', date: '08:10 pm' },
    { type: 'refund_upi', amount: -420, reason: 'REFUND: Takeaway \u2014 Anil (Asha)', date: '08:20 pm' },
    { type: 'unpaid_writeoff', amount: 180, reason: 'UNPAID: Table 7 \u2014 walked out (Priya)', date: '10:55 pm' },
    { type: 'cash_income', amount: 240, reason: 'Table 5 (Cash)', date: '<img src=x onerror=alert(1)>' },
    { type: 'expense', amount: 450, reason: 'Void: the old milk order', date: '07:00 pm' },
  ];
  real.renderLedger();
  const html = boxes['ledger-list'].innerHTML;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  check('a void is labelled once', /VOID: Table 4/.test(text) && !/VOID:\s*VOID:/i.test(text), text);
  check('and so are a refund and a write-off',
        !/REFUND:\s*REFUND:/i.test(text) && !/UNPAID:\s*UNPAID:/i.test(text) &&
        /REFUND: Takeaway/.test(text) && /UNPAID: Table 7/.test(text), text);
  check('a reason that merely starts with a similar word is left as it was written',
        /Void: the old milk order/.test(text), text);
  note('only the tag this screen is about to add is taken off the front');
  check('and the time on a line is escaped like the rest of it — it comes from the database too',
        !/<img/i.test(html) && /&lt;img/.test(html), html.slice(0, 400));
}

done();
