// A prepaid web order that is not paid has to reach someone.
//
// Takeaway and delivery are paid up front, and there are two ways one sits unpaid:
// the pay link never went out, or it went out and nothing came back. The POS had an
// alert for each. Only the first one worked.
//
// The second watched orders/track/{id}/needsManualVerify, and nothing in the repo
// ever wrote that flag — it was to be set by the customer's app at 120s, and that
// app deliberately does not, because it cannot know whether the link has even been
// sent. So the read returned null forever. Worse, the first alert skipped every
// order whose link HAD gone out, on the grounds that other alerts covered it:
// a customer who was sent a link and never paid produced no alert at all.
//
// write-only.test.js could not see this. It asks whether a path something reads is
// written somewhere, and orders/track/{id} certainly is — by five other writers.
// A dead FIELD hides inside a live node.
//
// The interval is lifted out of the page and run against a clock, so what is under
// test is which orders it decides to alert on and when.

const { readPage, suite } = require('./helpers');

const { check, note, done } = suite('Unpaid web orders — both alerts, or neither is a net');

const src = readPage('pos.html');

// The body of the setInterval, extracted with its guards intact.
const start = src.indexOf('// ===== A PREPAID WEB ORDER THAT IS NOT PAID =====');
if (start < 0) {
  throw new Error('the unpaid-web-order watcher was renamed or removed — update this suite');
}
const open = src.indexOf('setInterval(function(){', start);
const bodyStart = src.indexOf('{', open + 'setInterval(function('.length);
let depth = 0, i = bodyStart, bodyEnd = -1;
while (i < src.length) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
  i++;
}
if (bodyEnd < 0) throw new Error('could not read the watcher body out of pos.html');
const TICK = src.slice(bodyStart + 1, bodyEnd);

const MIN = 60000;

function till(orders, matched) {
  const pushes = [];
  const win = { pendingWebOrders: orders, _plAlerted: {}, _mvAlerted: {}, _wvMatch: matched || {} };
  const tick = new Function('window', 'Date', 'Math', 'posSendPush', 'now_', TICK.replace('const now = Date.now();', 'const now = now_;'));
  return {
    pushes,
    at: (now) => tick(win, Date, Math, (p) => pushes.push(p), now),
    titles: () => pushes.map(p => p.title),
  };
}

const NOW = 1756200000000;
const ORDER = (extra) => Object.assign(
  { orderType: 'Takeaway', tableOrAddress: 'Takeaway', total: 480, phone: '9990001111', createdAt: NOW }, extra);

// ------------------------------------------------- the link never went out
{
  const t = till({ o1: ORDER() });
  t.at(NOW + 4 * MIN);
  check('a link not yet sent is left alone for the first few minutes', t.pushes.length === 0, t.titles().join(', '));
  t.at(NOW + 6 * MIN);
  check('and is reported once it has been waiting',
        t.pushes.length === 1 && /never sent/i.test(t.pushes[0].title), t.titles().join(', '));
  t.at(NOW + 30 * MIN);
  check('once, not every minute', t.pushes.length === 1, t.pushes.length + ' push(es)');
}

// --------------------------------------- the link went out, nothing came back
{
  const t = till({ o1: ORDER({ payLinkSentAt: NOW + 2 * MIN }) });
  t.at(NOW + 8 * MIN);
  check('a link just sent is given time to be paid', t.pushes.length === 0, t.titles().join(', '));
  t.at(NOW + 13 * MIN);
  check('a link sent and unpaid IS reported',
        t.pushes.length === 1 && /still unpaid/i.test(t.pushes[0].title), t.titles().join(', '));
  note('this was the alert that could never fire — it waited on a flag nobody wrote');
  check('and the message says how long ago the link went, not how old the order is',
        /11 min ago/.test(t.pushes[0].body), t.pushes[0].body);
  check('the customer’s number rides along, so it can be chased from a lock screen',
        /9990001111/.test(t.pushes[0].body));
  t.at(NOW + 40 * MIN);
  check('once, not every minute', t.pushes.length === 1, t.pushes.length + ' push(es)');
}

// ------------------------------------------------------------ nothing to say
{
  const paid = till({ o1: ORDER({ payLinkSentAt: NOW, payment: { ref: '5123', amount: 480 } }) });
  paid.at(NOW + 60 * MIN);
  check('an order already booked is not chased', paid.pushes.length === 0, paid.titles().join(', '));

  const matching = till({ o1: ORDER({ payLinkSentAt: NOW }) }, { o1: '5123' });
  matching.at(NOW + 60 * MIN);
  check('nor is one whose credit has matched and is being booked', matching.pushes.length === 0,
        matching.titles().join(', '));
  note('the booking is a round trip; alerting inside it would cry wolf on every payment');

  const dinein = till({ o1: ORDER({ orderType: 'Dine-in' }) });
  dinein.at(NOW + 60 * MIN);
  check('and a dine-in order is not prepaid at all', dinein.pushes.length === 0, dinein.titles().join(', '));
}

// ------------------------------------------------------- the gap that existed
{
  // The exact order the old code was silent about: link sent, never paid.
  const t = till({ o1: ORDER({ payLinkSentAt: NOW }) });
  for (let m = 1; m <= 90; m++) t.at(NOW + m * MIN);
  check('an hour and a half of a sent-and-unpaid order raises exactly one alert',
        t.pushes.length === 1 && /still unpaid/i.test(t.pushes[0].title),
        t.pushes.length + ' push(es): ' + t.titles().join(', '));
  note('the old code raised none, for as long as the order existed');
}

done();
