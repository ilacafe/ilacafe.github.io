// GST invoices: the sums, the serial numbers and the document.
//
// gst.js is the one implementation the till, the owner's screen, the customer's
// invoice page and the Worker's monthly email all use. These are the properties an
// accountant would check first, and the ones that are easiest to get wrong by a paisa.

const path = require('path');
const { ROOT, readPage, extractFunction, suite } = require('./helpers');
const G = require(path.join(ROOT, 'gst.js'));
const { check, note, done } = suite('GST invoices — tax in a price, serials, GSTIN, the document');

// ------------------------------------------------------------------ tax in a price
{
  const t = G.taxSplit(450, 5);
  check('₹450 at 5% is ₹428.58 taxable and ₹10.71 each of CGST and SGST',
        t.taxable === 428.58 && t.cgst === 10.71 && t.sgst === 10.71, JSON.stringify(t));
  let worst = 0, unequal = 0;
  for (let paise = 1; paise <= 500000; paise += 7) {
    const total = paise / 100, s = G.taxSplit(total, 5);
    const back = Math.round((s.taxable + s.cgst + s.sgst) * 100);
    worst = Math.max(worst, Math.abs(back - paise));
    if (s.cgst !== s.sgst) unequal++;
  }
  check('taxable + CGST + SGST is the total to the paisa, for every amount up to ₹5,000', worst === 0, 'off by ' + worst);
  check('and CGST and SGST are always equal', unequal === 0);
  const t18 = G.taxSplit(1180, 18);
  check('the rate is a setting, not a constant', t18.taxable === 1000 && t18.cgst === 90, JSON.stringify(t18));
  const tbad = G.taxSplit(105, 'x');
  check('a rate that is not a number means the default 5%', tbad.rate === 5 && tbad.taxable === 100);
}

// ------------------------------------------------------------------ numbering
{
  check('the serial is PREFIX/YY-YY/NNNN', G.invoiceNo('ILA', '2026-27', 7) === 'ILA/26-27/0007');
  check('and stays within the 16 characters Rule 46 allows, to 99,999 a year',
        G.invoiceNo('WXYZ', '2026-27', 99999).length <= 16, G.invoiceNo('WXYZ', '2026-27', 99999));
  check('a prefix is cut to four letters or digits', G.cleanPrefix('ila café!') === 'ILAC');
  check('an empty prefix means ILA', G.cleanPrefix('') === 'ILA');
  const IST = 5.5 * 3600 * 1000;
  check('the year turns at midnight on 1 April in India, not in UTC',
        G.fyOf(Date.UTC(2027, 3, 1) - IST - 1) === '2026-27' && G.fyOf(Date.UTC(2027, 3, 1) - IST) === '2027-28');
  check('a month\'s range is its IST midnights', (() => {
    const r = G.monthRange('2026-11');
    return r.start === Date.UTC(2026, 10, 1) - IST && r.end === Date.UTC(2026, 11, 1) - IST;
  })());
  check('December\'s range ends at the new year', G.monthRange('2026-12').end === Date.UTC(2027, 0, 1) - IST);
  check('the month before January is last December', G.prevMonth(Date.UTC(2027, 0, 15)) === '2026-12');
  check('a month belongs to its financial year', G.fyOfMonth('2027-03') === '2026-27' && G.fyOfMonth('2027-04') === '2027-28');
}

// ------------------------------------------------------------------ GSTIN
{
  check('ILA\'s own GSTIN checks out', G.validGSTIN('05CPEPP3821F1Z4'));
  check('and is in Uttarakhand', G.stateOf('05CPEPP3821F1Z4').name === 'Uttarakhand');
  check('lower case and spaces are forgiven', G.validGSTIN(' 05cpepp3821f1z4 '));
  check('a wrong check character is caught', !G.validGSTIN('05CPEPP3821F1Z5'));
  check('two swapped digits are caught', !G.validGSTIN('05CPEPP3812F1Z4'));
  check('a GSTIN that is the wrong shape is refused', !G.validGSTIN('05CPEPP3821F1') && !G.validGSTIN(''));
  check('an unknown state code is refused', !G.validGSTIN('00CPEPP3821F1Z' + G.gstinCheckChar('00CPEPP3821F1Z')));
}

// ------------------------------------------------------------------ the draft
const SETTINGS = { legalName: 'Legal Name Of Proprietor', tradeName: 'ILA', address: 'Rajpur Road\nDehradun',
                   gstin: '05CPEPP3821F1Z4', rate: 5, sac: '996331', prefix: 'ILA' };
{
  check('settings without a name, address or GSTIN are not enough to invoice',
        G.settingsProblems({}).length === 3);
  check('and these are', G.settingsProblems(SETTINGS).length === 0);

  const items = { 'Latte': { qty: 2, price: 180 }, 'Margherita': { qty: 1, price: 450, base: 'Margherita', mods: null } };
  const d = G.draft({ settings: SETTINGS, items, total: 810, bill: { key: 'k1', label: 'Table 4', source: 'pos', at: 1 },
                      pay: { method: 'UPI', vpa: 'ila@hdfc' }, how: 'auto', by: 'Asha' });
  check('lines are quantity times price', d.items.length === 2 && d.items[0].a === 360 && d.items[1].a === 450);
  check('a bill that is its lines has no adjustment', !('adjust' in d));
  check('the seller is copied onto the invoice', d.seller.gstin === '05CPEPP3821F1Z4' && d.seller.state === 'Uttarakhand');
  check('the place of supply is the café', d.pos.code === '05');
  check('there is no IGST on a restaurant bill', d.igst === 0);
  check('nothing empty is written — the database refuses undefined',
        JSON.stringify(d).indexOf('null') < 0 && !('buyer' in d), JSON.stringify(d.buyer));

  const d2 = G.draft({ settings: SETTINGS, items, total: 800 });
  check('a bill whose total is less than its lines says so', d2.adjust === -10 && d2.gross === 810);

  const pub = G.publicCopy(Object.assign({}, d, { buyer: { name: 'Acme', gstin: '05CPEPP3821F1Z4', phone: '9999999999' } }));
  check('the customer\'s copy has their name and GSTIN', pub.buyer.name === 'Acme' && pub.buyer.gstin);
  check('but not their phone number, the café\'s account, who issued it, or the bill key',
        !pub.buyer.phone && !pub.pay.vpa && !pub.by && !pub.bill.key);
  check('and the original is left as it was', d.pay.vpa === 'ila@hdfc' && d.by === 'Asha');

  check('a mistyped buyer GSTIN is caught before it is printed',
        G.buyerProblems({ name: 'Acme', gstin: '05CPEPP3821F1Z5' }, 100).length === 1);
  check('₹50,000 to an unregistered buyer needs a name and address (Rule 46(e))',
        G.buyerProblems({}, 50000).length === 1 && G.buyerProblems({ name: 'A', address: 'B' }, 50000).length === 0);
  check('below that, nothing is required', G.buyerProblems({}, 49999).length === 0);
}

// ------------------------------------------------------------------ words
{
  check('₹450 in words', G.words(450) === 'Rupees Four Hundred Fifty Only');
  check('lakhs and crores, and paise', G.words(12345678.05) === 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Five Paise Only', G.words(12345678.05));
  check('Indian grouping in figures', G.inr(1234567.5) === '₹12,34,567.50');
}

// ------------------------------------------------------------------ the document
{
  const inv = Object.assign(G.draft({ settings: SETTINGS, items: { '<img src=x onerror=alert(1)>': { qty: 1, price: 100 } }, total: 100,
                                      bill: { label: 'Table "4"' }, buyer: { name: 'O\'Brien & Co' } }),
                            { no: 'ILA/26-27/0001', seq: 1, at: Date.UTC(2026, 10, 26, 8), token: 'x' });
  const html = G.render(inv);
  check('the document says TAX INVOICE', html.indexOf('TAX INVOICE') >= 0);
  check('and carries the number, GSTIN, SAC, both taxes and the total in words',
        ['ILA/26-27/0001', '05CPEPP3821F1Z4', '996331', 'CGST @ 2.5%', 'SGST @ 2.5%', 'Rupees One Hundred Only'].every(s => html.indexOf(s) >= 0));
  check('an item name is text, never markup', html.indexOf('<img') < 0 && html.indexOf('&lt;img') >= 0);
  check('nor a buyer\'s name', html.indexOf('O&#39;Brien &amp; Co') >= 0);
  const v = G.render(Object.assign({}, inv, { status: 'cancelled', cancelReason: 'wrong table' }));
  check('a cancelled invoice says so at the top', /gi-void">CANCELLED/.test(v) && v.indexOf('wrong table') >= 0);

  const inv2 = Object.assign({}, inv, { no: 'ILA/26-27/0002', seq: 2, buyer: { name: 'Acme', gstin: '05CPEPP3821F1Z4' } });
  const inv3 = Object.assign({}, inv, { no: 'ILA/26-27/0003', seq: 3, status: 'cancelled' });
  const sm = G.summary([inv3, inv, inv2]);
  check('the summary counts issued and cancelled apart', sm.issued === 2 && sm.cancelled === 1 && sm.count === 3);
  check('and runs the serials from first to last', sm.first === 'ILA/26-27/0001' && sm.last === 'ILA/26-27/0003');
  check('and leaves the cancelled one out of the money', sm.total === 200 && sm.b2b === 1 && sm.b2c === 1);

  const c = G.csv([inv2, inv]);
  const rows = c.replace(/^﻿/, '').trim().split('\r\n');
  check('the register is one row per invoice, in serial order', rows.length === 3 && rows[1].indexOf('ILA/26-27/0001') === 0);
  check('starts with a byte-order mark so Excel reads it as UTF-8', c.charCodeAt(0) === 0xfeff);
  check('and quotes what needs quoting', rows[1].indexOf('"Table ""4"""') >= 0);
  const evil = G.csv([Object.assign({}, inv, { buyer: { name: '=HYPERLINK("x")' } })]);
  check('a cell that would run as a formula in a spreadsheet does not', evil.indexOf(",\"'=HYPERLINK") >= 0, evil.split('\r\n')[1]);

  const b = G.book([inv2, inv], { title: 'November 2026' });
  check('the book is a whole document, a cover and one page per invoice',
        /^<!DOCTYPE html>/.test(b) && (b.match(/class="gi-page"/g) || []).length === 3);
  check('an empty month still produces a book that says so', G.book([], { title: 'x' }).indexOf('No invoices were issued') >= 0);
}

// --------------------------------------------- the two pages issue the same way
{
  const a = extractFunction(readPage('admin.html'), 'gstIssue');
  const p = extractFunction(readPage('pos.html'), 'gstIssue');
  check('the till and the admin screen issue an invoice with the same function', a === p);
  check('which writes the number, the invoice, the bill\'s index and the public copy in ONE update',
        /db\.ref\(\)\.update\(updates\)/.test(a) &&
        ["'gst/counter/'", "'gst/invoices/'", "'gst/byBill/'", "'gst/public/'"].every(k => a.indexOf("updates[" + k) >= 0));
  check('and answers a bill already invoiced with the invoice it has', /gst\/byBill\//.test(a) && /existing: true/.test(a));
  note('the rules make the number consecutive; this only has to ask again when another till took it');
}

done();
