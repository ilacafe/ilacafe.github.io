// Money going back out: a refund marked paid, and a settled bill voided.
//
// Both reverse real money, and both were three awaits in a row — flag the record,
// reverse the till, write the compensating ledger line — with nothing tying them
// together. Any one of them could be the last to land:
//
//   refund stopped after the ledger line   the till still counts money that has
//                                          already left the bank
//   refund stopped after the reversal      the refund is still listed as owed, so
//                                          it gets paid and recorded a second time
//   void stopped after the flag            the bill reads VOIDED with the till never
//                                          reversed, and the button that would
//                                          finish it is gone
//
// In every one of those the page said "Nothing was changed — try again", which was
// not true, and doing as it asked made the second copy.
//
// A multi-path update is atomic. These check each reversal is exactly one write,
// that the write carries all three parts, and that a second press cannot make a
// second copy of it.

const { readPage, extractAssignedFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Refunds and voids — one write, once');

const src = readPage('admin.html');
const clone = v => (v === null || v === undefined) ? v : JSON.parse(JSON.stringify(v));
const INCREMENT = (n) => ({ '.sv': { increment: n } });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// Every write the page makes, in order, with the paths one update touched kept
// together — which is the whole question here.
function harness(seed) {
  const state = Object.assign({}, seed);
  const writes = [];
  const ref = (path) => ({
    update(v) {
      writes.push({ at: path, value: clone(v) });
      Object.keys(v || {}).forEach(k => { state[path ? path + '/' + k : k] = clone(v[k]); });
      return Promise.resolve();
    },
    set(v) { writes.push({ at: path, value: clone(v), whole: true }); state[path] = clone(v); return Promise.resolve(); },
    push(v) {
      if (v === undefined) return { key: '-Nkey' + writes.length };
      writes.push({ at: path, value: clone(v), whole: true });
      return { key: '-Nkey' + writes.length };
    },
    once() { return Promise.resolve({ val: () => (state[path] === undefined ? null : clone(state[path])) }); }
  });
  return { writes, state, db: { ref: (p) => ref(p === undefined ? '' : String(p)) } };
}

function speech() {
  const said = { alerts: [] };
  return {
    said,
    globals: {
      firebase: { database: { ServerValue: { TIMESTAMP: 1756200000000, increment: INCREMENT } } },
      // These used to be alert/confirm/prompt. They are the app's own dialogs now,
      // because a browser dialog blocks the event loop and a till holding one has
      // stopped listening to the database. The shapes are what the page awaits:
      // ilaAsk resolves a boolean, ilaAskText a string or null when backed out.
      ilaAsk: () => Promise.resolve(true),
      ilaAskText: () => Promise.resolve('wrong amount charged'),
      ilaTell: (t, d) => { said.alerts.push(String(t) + ' ' + String(d || '')); return Promise.resolve(); },
      ilaToast: (m) => { said.alerts.push(String(m)); },
      Date, Math, JSON, Object, parseFloat, parseInt, String, console,
    }
  };
}
const trail = (h) => h.writes.map(w => w.at + ' [' + Object.keys(w.value || {}).join(', ') + ']').join(' | ') || '(nothing written)';

(async () => {
  // ---------------------------------------------------------------- refunds
  {
    const source = extractAssignedFunction(src, 'refundDone');
    const DUE = (extra) => Object.assign(
      { amount: 640, tableOrAddress: 'Web order', phone: '9990001111', payId: 'web_tk9' }, extra);

    const till = (row) => {
      const h = harness();
      const s = speech();
      const api = buildModule([source], Object.assign(
        { db: h.db, refundsCache: { r1: DUE(row) }, window: { currentAdmin: { name: 'Ravi' }, _refunding: {} } },
        s.globals), ['refundDone']);
      return { h, said: s.said, api };
    };

    const t = till();
    t.api.refundDone('r1'); await settle();

    check('a refund is one write, not three', t.h.writes.length === 1, trail(t.h));
    const w = t.h.writes[0] || { at: '?', value: {} };
    check('and it is at the root, so that one write spans all three nodes', w.at === '', w.at);
    check('it writes the compensating ledger line',
          Object.keys(w.value).some(p => p.indexOf('pos/ledgerEntries/') === 0), trail(t.h));
    check('it reverses the day’s UPI total by the refund',
          JSON.stringify(w.value['pos/upiTotal']) === JSON.stringify(INCREMENT(-640)),
          JSON.stringify(w.value['pos/upiTotal']));
    check('and it marks the refund done in the same write',
          w.value['orders/refundsDue/r1/status'] === 'refunded' &&
          w.value['orders/refundsDue/r1/refundedBy'] === 'Ravi', trail(t.h));
    note('so the row cannot leave the list without the money being recorded, or the reverse');

    t.api.refundDone('r1'); await settle();
    check('a second press records nothing further', t.h.writes.length === 1, trail(t.h));
    note('the row stays tappable for a round trip after the confirm');

    const already = till({ status: 'refunded' });
    already.api.refundDone('r1'); await settle();
    check('a refund already recorded is refused, and says so',
          already.h.writes.length === 0 && already.said.alerts.some(a => /already recorded/i.test(a)),
          trail(already.h) + ' · said: ' + (already.said.alerts.join(' / ') || '(nothing)'));
  }

  // ------------------------------------------------------------------ voids
  {
    const source = extractAssignedFunction(src, 'voidBill');
    const BILL = (method) => ({ payment: { total: 1250, method: method, verified: true }, tableOrAddress: 'Table 2' });

    const till = (method, alreadyVoided) => {
      const h = harness(alreadyVoided ? { 'orders/history/b1/voided': true } : {});
      const s = speech();
      const api = buildModule([source], Object.assign({
        db: h.db, voidBillsCache: { b1: BILL(method) },
        window: { currentAdmin: { name: 'Ravi' }, _voiding: {} },
        loadVoidBills: () => {}, ilaPushBody: () => Promise.resolve(null),
        ALERT_WORKER_URL: '', fetch: () => Promise.resolve({}),
      }, s.globals), ['voidBill']);
      return { h, said: s.said, api };
    };

    const upi = till('UPI');
    upi.api.voidBill('b1'); await settle();
    check('a void is one write, not three', upi.h.writes.length === 1, trail(upi.h));
    const v = upi.h.writes[0] || { at: '?', value: {} };
    check('it flags the archived bill, which is kept either way',
          v.value['orders/history/b1/voided'] === true &&
          v.value['orders/history/b1/voidBy'] === 'Ravi', trail(upi.h));
    check('it reverses the till',
          JSON.stringify(v.value['pos/upiTotal']) === JSON.stringify(INCREMENT(-1250)),
          JSON.stringify(v.value['pos/upiTotal']));
    check('and it writes the visible reversal line',
          Object.keys(v.value).some(p => p.indexOf('pos/ledgerEntries/') === 0), trail(upi.h));
    check('a UPI bill comes off the UPI total and not the drawer',
          !('pos/cashDrawer' in v.value), Object.keys(v.value).join(', '));

    const cash = till('Cash');
    cash.api.voidBill('b1'); await settle();
    const c = cash.h.writes[0] || { value: {} };
    check('a cash bill comes off the drawer and not the UPI total',
          JSON.stringify(c.value['pos/cashDrawer']) === JSON.stringify(INCREMENT(-1250)) &&
          !('pos/upiTotal' in c.value), Object.keys(c.value).join(', '));
    note('written as two keys rather than one ternary, so the access map can place both');

    const twice = till('UPI');
    twice.api.voidBill('b1'); await settle();
    twice.api.voidBill('b1'); await settle();
    check('a second press reverses nothing further', twice.h.writes.length === 1, trail(twice.h));

    const elsewhere = till('UPI', true);
    elsewhere.api.voidBill('b1'); await settle();
    check('a bill voided elsewhere is refused against the database, not the cache',
          elsewhere.h.writes.length === 0 &&
          elsewhere.said.alerts.some(a => /already been voided/i.test(a)),
          trail(elsewhere.h) + ' · said: ' + (elsewhere.said.alerts.join(' / ') || '(nothing)'));
    note('voidBillsCache is a one-shot read — it says what was true when the list loaded');
  }

  done();
})();
