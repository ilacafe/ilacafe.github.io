// Cash leaving the drawer, checked where a browser cannot skip the check.
//
// expense, withdrawal and tip_payout each hand real money to a real person, and
// each sat behind a staff PIN prompt in pos.html. That prompt was advice. The rule
// on pos is "has a staff role", so anyone who could open the till could push an
// entry with a colleague's name on it without knowing any PIN at all — and the
// prompt itself runs in a browser the same person controls. docs/database-access.md
// has said so for as long as it has existed, and called moving these writes into
// the Worker the real fix.
//
// This is that fix under test. The Worker holds the one credential no browser has,
// resolves the PIN against staff itself, and writes the entry and the drawer
// movement as one atomic write. The rules refuse these three types from anyone
// else — that half is checked by the emulator suite, which is where rules are
// answerable.
//
// The functions are lifted out of worker.js rather than copied, so a rename fails
// loudly instead of leaving this passing against code that no longer ships.

const crypto = require('crypto');
const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Cash and stock — the PIN as a gate');

const src = readPage('worker/worker.js');

// Pulled from the source, not restated: the list of types this gate covers is the
// thing most likely to drift, and a copy here would drift with nobody noticing.
const typesLine = /const CASHOUT_TYPES = \[[^\]]*\];/.exec(src);
const saltLine = /const PIN_SALT = '[^']*';/.exec(src);
if (!typesLine || !saltLine) throw new Error('CASHOUT_TYPES or PIN_SALT no longer look the way this suite reads them');

const SALT = /'([^']*)'/.exec(saltLine[0])[1];
const hashOf = (pin) => crypto.createHash('sha256').update(SALT + pin).digest('hex');

const STAFF = { [hashOf('4821')]: 'Priya', [hashOf('9090')]: 'Sam' };
const RECIPES = { 'Cold Brew Concentrate': { 'Coffee Beans': 0.2, 'Water': 1.5 } };

let calls, staffNode, patchOk;
function makeApi() {
  calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
    if (String(url).includes('/staff.json')) {
      return { ok: staffNode !== null, json: async () => staffNode };
    }
    if (String(url).includes('/inventory/recipes/')) {
      const name = decodeURIComponent(String(url).split('/inventory/recipes/')[1].split('.json')[0]);
      return { ok: true, json: async () => (RECIPES[name] || null) };
    }
    return { ok: patchOk, json: async () => ({}) };
  };
  return buildModule([
    typesLine[0], saltLine[0],
    extractFunction(src, 'istClock'),
    extractFunction(src, 'pinToName'),
    extractFunction(src, 'handleCashout'),
    /const INV_KINDS = \[[^\]]*\];/.exec(src)[0],
    extractFunction(src, 'invSafeKey'),
    extractFunction(src, 'handleInventoryLog'),
  ], {
    DB_URL: 'https://db.test', _enc: new TextEncoder(), crypto,
    fetch: fakeFetch,
    getRobotToken: async () => 'robot-token',
    Date, Math, JSON, String, Number, Object, Array, Uint8Array, isFinite, console,
  }, ['handleCashout', 'istClock', 'pinToName', 'CASHOUT_TYPES', 'handleInventoryLog', 'invSafeKey']);
}

const CLAIMS = { sub: 'cashierUid' };
const good = (over) => Object.assign({ type: 'expense', amount: 450, reason: 'milk', pin: '4821' }, over);

(async () => {
  // --------------------------------------------------------------- the happy path
  {
    staffNode = STAFF; patchOk = true;
    const api = makeApi();
    const r = await api.handleCashout(good(), CLAIMS);
    check('a valid PIN records the cash-out', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
    check('and reports the name the PIN resolved to', r.body.by === 'Priya', r.body.by);

    const patch = calls.find(c => c.method === 'PATCH');
    check('it is one write at the root, not two', calls.filter(c => c.method === 'PATCH').length === 1,
          calls.map(c => c.method + ' ' + c.url.split('?')[0]).join(' | '));
    const sent = JSON.parse(patch.body);
    const key = Object.keys(sent).find(k => k.indexOf('pos/ledgerEntries/') === 0);
    check('the ledger line and the drawer move together',
          !!key && 'pos/cashDrawer' in sent, Object.keys(sent).join(', '));
    note('a line with no drawer movement, or the reverse, is a till nobody can reconcile');
    check('the drawer goes down by the amount',
          JSON.stringify(sent['pos/cashDrawer']) === JSON.stringify({ '.sv': { increment: -450 } }),
          JSON.stringify(sent['pos/cashDrawer']));
    check('the entry keeps the amount positive, as the ledger has always stored it',
          sent[key].amount === 450, String(sent[key].amount));
    check('the reason carries the name the PIN gave', /milk \(Priya\)/.test(sent[key].reason), sent[key].reason);
    check('and the entry also carries the account that was actually signed in',
          sent[key].byUid === 'cashierUid' && sent[key].by === 'Priya',
          JSON.stringify({ by: sent[key].by, byUid: sent[key].byUid }));
    note('the name is what the PIN said; byUid is what a PIN cannot forge');
    check('the timestamp is the server’s, not the Worker’s clock',
          JSON.stringify(sent[key].ts) === JSON.stringify({ '.sv': 'timestamp' }), JSON.stringify(sent[key].ts));
  }

  // ------------------------------------------------------------------ the refusals
  {
    staffNode = STAFF; patchOk = true;
    const api = makeApi();
    const refused = [];
    const must = async (what, over, status) => {
      const before = calls.filter(c => c.method === 'PATCH').length;
      const r = await api.handleCashout(good(over), CLAIMS);
      const wrote = calls.filter(c => c.method === 'PATCH').length > before;
      if (r.status !== status || wrote) refused.push(what + ' → ' + r.status + (wrote ? ' AND WROTE' : ''));
    };
    await must('a wrong PIN', { pin: '0000' }, 403);
    await must('no PIN at all', { pin: '' }, 403);
    await must('a type that is not a cash-out', { type: 'cash_income' }, 400);
    await must('an income type dressed as one', { type: 'upi_income' }, 400);
    await must('a write-off, which end-of-day still records itself', { type: 'unpaid_writeoff' }, 400);
    await must('a negative amount', { amount: -450 }, 400);
    await must('a zero amount', { amount: 0 }, 400);
    await must('an amount that is not a number', { amount: 'lots' }, 400);
    await must('an absurd amount', { amount: 99999999 }, 400);
    await must('no reason', { reason: '   ' }, 400);
    check('everything that should be refused is, and none of it writes anything',
          refused.length === 0, refused.join('; '));
    note('unpaid_writeoff is deliberately not here — it moves no cash, and it happens');
    note('inside end-of-day, which has to complete when this Worker is unreachable');
  }

  // ------------------------------------------------------- what the reason may be
  {
    staffNode = STAFF; patchOk = true;
    const api = makeApi();
    await api.handleCashout(good({ reason: 'gas\u0000\u001b cylinder' }), CLAIMS);
    let sent = JSON.parse(calls.filter(c => c.method === 'PATCH').pop().body);
    let key = Object.keys(sent).find(k => k.indexOf('pos/ledgerEntries/') === 0);
    check('control characters are stripped out of the reason',
          !/[\u0000-\u001f\u007f]/.test(sent[key].reason), JSON.stringify(sent[key].reason));
    note('it ends up in a push notification and on the ledger screen');

    await api.handleCashout(good({ reason: 'x'.repeat(4000) }), CLAIMS);
    sent = JSON.parse(calls.filter(c => c.method === 'PATCH').pop().body);
    key = Object.keys(sent).find(k => k.indexOf('pos/ledgerEntries/') === 0);
    check('and a very long one is bounded', sent[key].reason.length < 250, sent[key].reason.length + ' chars');
  }

  // ------------------------------------------------------------ when things break
  {
    staffNode = null; patchOk = true;               // the robot cannot read staff
    let api = makeApi();
    let r = await api.handleCashout(good(), CLAIMS);
    check('a staff map it cannot read is a refusal, not a free pass',
          r.status === 403 && calls.filter(c => c.method === 'PATCH').length === 0, JSON.stringify(r.body));
    note('failing open here would let any PIN through the moment a rule changed');

    staffNode = STAFF; patchOk = false;             // the write is rejected
    api = makeApi();
    r = await api.handleCashout(good(), CLAIMS);
    check('a write the database refuses is reported, not swallowed',
          r.status === 502 && r.body.ok !== true, JSON.stringify(r.body));
  }

  // ------------------------------------------------------------------ the clock
  {
    const api = makeApi();
    // 2026-08-26T09:34:00Z is 15:04 in India.
    check('the ledger time is the café’s, not the Worker’s',
          api.istClock(Date.UTC(2026, 7, 26, 9, 34)) === '03:04 pm',
          api.istClock(Date.UTC(2026, 7, 26, 9, 34)));
    note('a Worker runs in UTC; this string is displayed on the till exactly as written');
    check('and midnight reads as twelve, not zero',
          api.istClock(Date.UTC(2026, 7, 26, 18, 30)) === '12:00 am',
          api.istClock(Date.UTC(2026, 7, 26, 18, 30)));
  }

  // =================================================== stock on and off the shelf
  //
  // The same fix, and this one closes the hole completely where the cash-out could
  // not: inventory/stock and inventory/logs are written by exactly one page, so the
  // robot can be made the only writer without anything needing to work offline.
  {
    staffNode = STAFF; patchOk = true;
    const api = makeApi();
    const inv = (over) => Object.assign(
      { kind: 'receive', item: 'Coffee Beans', qty: 5, pin: '4821' }, over);
    const lastPatch = () => JSON.parse(calls.filter(c => c.method === 'PATCH').pop().body);

    let r = await api.handleInventoryLog(inv(), CLAIMS);
    check('a delivery adds to stock and logs who received it',
          r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
    let sent = lastPatch();
    let logKey = Object.keys(sent).find(k => k.indexOf('inventory/logs/') === 0);
    check('the stock movement and the line explaining it are one write',
          JSON.stringify(sent['inventory/stock/Coffee Beans']) === JSON.stringify({ '.sv': { increment: 5 } }) &&
          !!logKey, Object.keys(sent).join(', '));
    note('stock that moved with nothing explaining it is the state this exists to prevent');
    check('the log names the PIN holder and the account behind it',
          sent[logKey].staff === 'Priya' && sent[logKey].byUid === 'cashierUid',
          JSON.stringify({ staff: sent[logKey].staff, byUid: sent[logKey].byUid }));

    r = await api.handleInventoryLog(inv({ kind: 'prep', item: 'Cold Brew Concentrate', qty: 2 }), CLAIMS);
    check('a prepped batch yields stock and takes the recipe off the shelf',
          r.status === 200, JSON.stringify(r.body));
    sent = lastPatch();
    check('by the recipe the Worker read, times the batch size',
          JSON.stringify(sent['inventory/stock/Coffee Beans']) === JSON.stringify({ '.sv': { increment: -0.4 } }) &&
          JSON.stringify(sent['inventory/stock/Water']) === JSON.stringify({ '.sv': { increment: -3 } }),
          JSON.stringify(sent));
    note('read here, never sent — a client that computes its own deductions can under-report');
    logKey = Object.keys(sent).find(k => k.indexOf('inventory/logs/') === 0);
    check('and the log says what came off the shelf',
          /0\.4 of Coffee Beans/.test(sent[logKey].deductions), sent[logKey].deductions);

    const refused = [];
    const must = async (what, over, status) => {
      const before = calls.filter(c => c.method === 'PATCH').length;
      const res = await api.handleInventoryLog(inv(over), CLAIMS);
      const wrote = calls.filter(c => c.method === 'PATCH').length > before;
      if (res.status !== status || wrote) refused.push(what + ' → ' + res.status + (wrote ? ' AND WROTE' : ''));
    };
    await must('a wrong PIN', { pin: '0000' }, 403);
    await must('a kind that is neither', { kind: 'shrinkage' }, 400);
    await must('a negative quantity', { qty: -5 }, 400);
    await must('a quantity that is not a number', { qty: 'some' }, 400);
    await must('a prep with no recipe', { kind: 'prep', item: 'Coffee Beans' }, 400);
    check('everything that should be refused is, and none of it moves stock',
          refused.length === 0, refused.join('; '));

    // An item name becomes a database path.
    const escapes = ['../users/adminUid', 'a/b', 'x.y', 'x$y', 'x#y', 'x[y]', '', '   '];
    const got = escapes.filter(n => api.invSafeKey(n) !== null);
    check('an item name that would write somewhere else is refused', got.length === 0,
          JSON.stringify(got));
    const slash = await api.handleInventoryLog(inv({ item: 'x/../../users/adminUid' }), CLAIMS);
    check('and the route refuses it rather than building the path',
          slash.status === 400, JSON.stringify(slash.body));
    note('Firebase forbids most of these outright; a client is not the place to find out');
  }

  // ------------------------------------------- the till no longer writes these
  {
    const pos = readPage('pos.html');
    const gone = ["addLedgerEntry(window.currentTransactionType", "addLedgerEntry('tip_payout'"];
    const left = gone.filter(g => pos.includes(g));
    check('pos.html no longer writes a cash-out into the ledger itself',
          left.length === 0, left.join('; '));
    check('it asks the Worker instead', /posCashOut\('tip_payout'/.test(pos) &&
          /posCashOut\(window\.currentTransactionType/.test(pos));
    check('and it no longer needs the staff map to decide whether the PIN was right',
          !/staffPins\[await hashPin\(pinStr\)\]/.test(pos.slice(pos.indexOf('window.confirmTransaction'))) ||
          !/window\.confirmTransaction[\s\S]{0,600}staffPins/.test(pos));
    note('the void prompt still checks a PIN in the page — that one only stamps a name');

    const invPage = readPage('inventory.html');
    check('inventory.html no longer writes stock or its log either',
          !/inventory\/stock\/|inventory\/logs\//.test(invPage));
    check('and it asks the Worker instead', /invLogToWorker\(/.test(invPage));
  }

  done();
})();
