// GST invoices in the real pages: two tills, the owner's screen and the customer's link.
//
// gst.test.js holds the arithmetic and rules-emulator.test.js holds the rules. This
// holds what neither can: that the till actually issues an invoice when a bill closes,
// for the bills the settings say and no others; that two tills issuing at once get
// consecutive numbers and never the same one; that a bill asked for twice is invoiced
// once; that the owner can cancel one; and that the customer's link shows it.
//
// One database, shared by every page (test/shared-db.js), with a shadow of the rules
// that matter here: the counter moves by one, to the number an invoice is being
// written at, and a bill's index is written once.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');
const { createServer, fbArrays } = require('./shared-db');
const G = require(path.join(ROOT, 'gst.js'));

const { check, note, done } = suite('GST invoices — in the till, the owner’s screen and the customer’s link');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const web = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not here'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CURRENT = 'ila.current@hdfcbank';      // the account that issues invoices
const SAVINGS = 'ila.one@okaxis';            // one that does not
const key = (v) => String(v).trim().toLowerCase().replace(/[.#$\[\]\/]/g, '_');
const SETTINGS = {
  legalName: 'Proprietor Name', tradeName: 'ILA', address: 'Rajpur Road, Dehradun, Uttarakhand',
  gstin: '05CPEPP3821F1Z4', prefix: 'ILA', sac: '996331', rate: 5, mode: 'accounts',
  accounts: { [key(CURRENT)]: true }
};
const FY = G.fyOf(Date.now());

// The rules' shadow. database.rules.json is what enforces these; the emulator suite
// proves it does. This is what makes the shared database answer the same way.
function gstRules(next, prev, writes) {
  const nc = (next.gst && next.gst.counter) || {}, pc = (prev.gst && prev.gst.counter) || {};
  const ni = (next.gst && next.gst.invoices) || {}, pi = (prev.gst && prev.gst.invoices) || {};
  const pb = (prev.gst && prev.gst.byBill) || {};
  for (const w of writes || []) {
    const m = /^gst\/(counter|invoices|byBill)\/([^/]+)(?:\/([^/]+))?(\/.+)?$/.exec(w.path);
    if (!m) continue;
    const [, node, a, b, deeper] = m;
    if (node === 'counter') {
      if (nc[a] !== (pc[a] || 0) + 1) return 'gst/counter/' + a + ' may only move up by one';
      if (!(ni[a] && ni[a][nc[a]])) return 'gst/counter/' + a + ' moved without an invoice at ' + nc[a];
    }
    if (node === 'invoices' && b && !deeper) {
      const was = pi[a] && pi[a][b], now = ni[a] && ni[a][b];
      if (was) return 'gst/invoices/' + a + '/' + b + ' is already issued';
      if (!now || now.seq !== nc[a] || String(now.seq) !== b) return 'gst/invoices/' + a + '/' + b + ' is not the next number';
    }
    if (node === 'byBill' && pb[a] && w.value !== null) return 'gst/byBill/' + a + ' is already invoiced';
  }
  return null;
}

(async () => {
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + web.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const pageErrors = [];
  const contexts = [];

  const srv = createServer({
    users: { u1: { role: 'cashier', name: 'Counter' }, owner: { role: 'admin', name: 'Owner' } },
    menu: { Coffee: { 'Filter Coffee': { price: 120, routing: 'barista' } } },
    settings: { upiList: [CURRENT, SAVINGS] },
    upiRouting: { config: {
      [key(CURRENT)]: { id: CURRENT, label: 'HDFC Current', bank: 'hdfc 1234', active: true, monthlyCap: 0, yearlyCap: 0 },
      [key(SAVINGS)]: { id: SAVINGS, label: 'Axis Savings', bank: 'axis 8020', active: true, monthlyCap: 100000, yearlyCap: 1000000 }
    } },
    gst: { settings: SETTINGS },
    pos: { cashDrawer: 1000, upiTotal: 0 }
  }, { rules: gstRules });

  async function open(name, page, uid) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1180, height: 900 } });
    contexts.push(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', e => { pageErrors.push(name + ': ' + String(e.message || e).split('\n')[0]); if (process.env.GST_DEBUG) console.log('STACK', name, String(e.stack).split('\n').slice(0, 5).join(' | ')); });
    // Before attach: the database client reads who is signed in when it starts.
    if (uid) await p.addInitScript((u) => { window.__TILL_UID = u; }, uid);
    await srv.attach(p, name);
    await p.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await p.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
    return p;
  }
  async function till(name) {
    const p = await open(name, 'pos.html');
    await p.waitForFunction(() => window.currentStaff && window.currentStaff.role, null, { timeout: 15000 });
    await p.waitForFunction(() => window.gstSettings && window.gstSettings.gstin, null, { timeout: 5000 });
    await p.evaluate(() => {
      window.__told = [];
      window.ilaToast = (m) => { window.__told.push(String(m)); };
      window.ilaTell = (t, d) => { window.__told.push(String(t) + ' — ' + (d || '')); return Promise.resolve(); };
      const real = window.showToast;
      window.showToast = function (t, d) { window.__told.push(String(t) + ' — ' + (d || '')); try { return real.apply(this, arguments); } catch (e) {} };
      try { showToast = window.showToast; } catch (e) {}
    });
    return p;
  }
  const quiet = async (ms) => { await sleep(ms || 400); await srv.settle(); await sleep(60); await srv.settle(); };
  const invoices = () => Object.values((srv.get('gst/invoices/' + FY)) || {}).filter(Boolean).sort((a, b) => a.seq - b.seq);
  const draftOn = (p, label, total, vpa) => p.evaluate(([label, total, vpa]) => IlaGST.draft({
    settings: window.gstSettings, items: { 'Filter Coffee': { qty: total / 120, price: 120 } }, total: total,
    bill: { key: 'x', label: label, source: 'pos', at: Date.now() }, pay: { method: 'UPI', vpa: vpa }, how: 'asked', by: 'test'
  }), [label, total, vpa]);

  try {
    const A = await till('A'), B = await till('B');

    // ======================================================= two tills, one numbering
    {
      const [dA, dB] = [await draftOn(A, 'Table 1', 240, CURRENT), await draftOn(B, 'Table 2', 360, CURRENT)];
      const [rA, rB] = await Promise.all([
        A.evaluate(([d]) => gstIssue(d, 'race-a', window.gstSettings), [dA]),
        B.evaluate(([d]) => gstIssue(d, 'race-b', window.gstSettings), [dB])
      ]);
      await quiet();
      const inv = invoices();
      check('two tills issuing at the same moment get two invoices', inv.length === 2, inv.map(i => i.no).join(', '));
      check('numbered 1 and 2 — consecutive, neither shared nor skipped',
            inv[0].no === G.invoiceNo('ILA', FY, 1) && inv[1].no === G.invoiceNo('ILA', FY, 2), inv.map(i => i.no).join(', '));
      check('and the counter says 2', srv.get('gst/counter/' + FY) === 2);
      check('each bill points at its own invoice', srv.get('gst/byBill/race-a') !== srv.get('gst/byBill/race-b') &&
            [rA.ref, rB.ref].sort().join() === [FY + '/1', FY + '/2'].join());
      note('the second till was refused, read the counter again and took the next number');

      const [dC1, dC2] = [await draftOn(A, 'Table 3', 120, CURRENT), await draftOn(B, 'Table 3', 120, CURRENT)];
      const [r1, r2] = await Promise.all([
        A.evaluate(([d]) => gstIssue(d, 'same-bill', window.gstSettings), [dC1]),
        B.evaluate(([d]) => gstIssue(d, 'same-bill', window.gstSettings), [dC2])
      ]);
      await quiet();
      check('one bill asked for on both tills at once is invoiced once', invoices().length === 3, invoices().map(i => i.no).join(', '));
      check('and the till that lost is told which invoice it has', (r1.existing || r2.existing) && r1.ref === r2.ref, JSON.stringify([r1, r2]));
    }

    // ======================================================= a bill closing, end to end
    {
      const before = invoices().length;
      srv.write('pos/activeTables/7', { items: { 'Filter Coffee': { qty: 3, price: 120 } }, total: 360, paid: 0, notes: '' });
      await quiet(300);
      const res = await A.evaluate(() => new Promise(r => settleTablePayment('7', 360, 'UPI', { via: 'ila.current@hdfcbank' }, r)));
      await quiet(900);
      check('a bill paid by UPI into the current account closes', res.closed === true, JSON.stringify(res));
      const inv = invoices();
      const last = inv[inv.length - 1];
      check('and is invoiced by itself', inv.length === before + 1 && last && last.how === 'auto' && last.total === 360,
            inv.length + ' invoices; last ' + JSON.stringify(last && { no: last.no, how: last.how, total: last.total }));
      check('for what was paid, with the tax in it', last && last.taxable === 342.86 && last.cgst === 8.57 && last.sgst === 8.57,
            last && [last.taxable, last.cgst, last.sgst].join(' / '));
      check('naming the account it was paid into', last && last.pay && last.pay.vpa === CURRENT && last.pay.method === 'UPI');
      const hist = srv.get('orders/history') || {};
      const hk = Object.keys(hist).find(k => hist[k] && hist[k].tableOrAddress === 'Table 7');
      check('one key names the bill in its history, its line in the day’s bills and its invoice',
            !!hk && last.bill && last.bill.key === hk && srv.get('gst/byBill/' + hk) === FY + '/' + last.seq &&
            Object.values(srv.get('pos/bills') || {}).some(b => b.key === hk),
            'history ' + hk + ', invoice bill ' + (last && last.bill && last.bill.key));
      check('and the history says which account was paid', hist[hk] && hist[hk].payment && (hist[hk].payment.upi || [])[0] === CURRENT);
      const pub = srv.get('gst/public/' + last.token);
      check('the customer’s copy is written with it', pub && pub.no === last.no && pub.total === 360);
      check('without the café’s account or who issued it', pub && !(pub.pay && pub.pay.vpa) && !pub.by);
    }
    {
      const before = invoices().length;
      srv.write('pos/activeTables/8', { items: { 'Filter Coffee': { qty: 1, price: 120 } }, total: 120, paid: 0, notes: '' });
      await quiet(300);
      await A.evaluate(() => new Promise(r => settleTablePayment('8', 120, 'UPI', { via: 'ila.one@okaxis' }, r)));
      srv.write('pos/activeTables/9', { items: { 'Filter Coffee': { qty: 1, price: 120 } }, total: 120, paid: 0, notes: '' });
      await quiet(300);
      await A.evaluate(() => new Promise(r => settleTablePayment('9', 120, 'Cash', {}, r)));
      await quiet(900);
      check('a bill paid into an account that is not ticked is not invoiced', invoices().length === before);
      check('nor one paid in cash', invoices().length === before);
    }
    {
      srv.write('pos/activeTables/10', { items: { 'Filter Coffee': { qty: 2, price: 120 } }, total: 240, paid: 0, notes: '' });
      await quiet(300);
      await A.evaluate(() => new Promise(r => settleTablePayment('10', 120, 'Cash', {}, r)));
      await quiet(300);
      const before = invoices().length;
      await B.evaluate(() => new Promise(r => settleTablePayment('10', 120, 'UPI', { via: 'ila.current@hdfcbank' }, r)));
      await quiet(900);
      const last = invoices()[invoices().length - 1];
      check('a bill split between cash on one till and the current account on the other is invoiced whole',
            invoices().length === before + 1 && last.total === 240 && last.pay.method === 'UPI + Cash',
            last && (last.total + ' ' + (last.pay && last.pay.method)));
      note('the account travels on the table, so the till that closes it knows, whichever took the UPI');
    }
    {
      srv.write('gst/settings/mode', 'all');
      await quiet(300);
      const before = invoices().length;
      srv.write('pos/activeTables/11', { items: { 'Filter Coffee': { qty: 1, price: 120 } }, total: 120, paid: 0, notes: '' });
      await quiet(300);
      await A.evaluate(() => new Promise(r => settleTablePayment('11', 120, 'Cash', {}, r)));
      await quiet(900);
      check('with "every bill" set, a cash bill is invoiced too', invoices().length === before + 1 && invoices()[invoices().length - 1].pay.method === 'Cash');
      srv.write('gst/settings/mode', 'off');
      await quiet(300);
      srv.write('pos/activeTables/12', { items: { 'Filter Coffee': { qty: 1, price: 120 } }, total: 120, paid: 0, notes: '' });
      await quiet(300);
      await A.evaluate(() => new Promise(r => settleTablePayment('12', 120, 'UPI', { via: 'ila.current@hdfcbank' }, r)));
      await quiet(900);
      check('and with "none", not even a current-account one', invoices().length === before + 1);
      srv.write('gst/settings/mode', 'accounts');
      await quiet(300);
    }

    // ======================================================= a customer asks, at the till
    let askedToken = null;
    {
      const id = await A.evaluate(() => { const b = (window.pastBills || []).find(x => x.table === 'Table 12'); return b ? b.id : null; });
      check('the bill nobody invoiced is in the till’s History', !!id);
      await A.evaluate((id) => { window.viewPastBill(id); return window.openGstInvoice(); }, id);
      await quiet(300);
      const formShown = await A.evaluate(() => !document.getElementById('gst-inv-form').hidden);
      check('asking for an invoice offers the form for the customer’s details', formShown);
      await A.fill('#gst-buyer-name', 'Acme Foods Pvt Ltd');
      await A.fill('#gst-buyer-gstin', '05CPEPP3821F1Z5');
      await A.evaluate(() => window.gstIssueFromHistory());
      const said = await A.evaluate(() => document.getElementById('gst-inv-status').textContent);
      check('a mistyped GSTIN is caught before anything is issued', /does not check out/.test(said), said);
      await A.fill('#gst-buyer-gstin', '05cpepp3821f1z4');
      await A.evaluate(() => window.gstIssueFromHistory());
      await quiet(600);
      const last = invoices()[invoices().length - 1];
      check('then it is issued, with their name and GSTIN on it',
            last.how === 'asked' && last.buyer && last.buyer.name === 'Acme Foods Pvt Ltd' && last.buyer.gstin === '05CPEPP3821F1Z4',
            JSON.stringify(last.buyer));
      const shown = await A.evaluate(() => ({ status: document.getElementById('gst-inv-status').textContent, done: !document.getElementById('gst-inv-done').hidden }));
      check('and the till shows its number, with a way to send it', shown.done && shown.status.indexOf(last.no) === 0, shown.status);
      askedToken = last.token;
      await A.evaluate(() => window.openGstInvoice());
      await quiet(300);
      const again = await A.evaluate(() => ({ form: !document.getElementById('gst-inv-form').hidden, status: document.getElementById('gst-inv-status').textContent }));
      check('asking again shows the same invoice rather than issuing another', !again.form && again.status.indexOf(last.no) === 0, again.status);
    }

    // ======================================================= the customer's link
    {
      const p = await open('customer', 'invoice.html?t=' + askedToken);
      await p.route('https://ila-cafe-default-rtdb.asia-southeast1.firebasedatabase.app/**', route => {
        const m = /\/gst\/public\/([A-Za-z0-9]+)\.json/.exec(route.request().url());
        // over REST, the way Firebase answers it: a dense list comes back as an array
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m ? fbArrays(JSON.parse(JSON.stringify(srv.get('gst/public/' + m[1])))) : null) });
      });
      await p.reload({ waitUntil: 'domcontentloaded' });
      await p.waitForSelector('article.gi', { timeout: 5000 }).catch(() => {});
      const text = await p.evaluate(() => document.body.innerText);
      check('the link opens the invoice', /TAX INVOICE/.test(text) && text.indexOf(invoices()[0] ? '' : 'x') >= 0);
      check('with the café’s GSTIN, the customer’s, and the tax', /05CPEPP3821F1Z4/.test(text) && /Acme Foods Pvt Ltd/.test(text) && /CGST @ 2.5%/.test(text));
      check('and nothing it should not carry', text.indexOf('hdfcbank') < 0 && text.indexOf('okaxis') < 0);
      const bad = await open('stranger', 'invoice.html?t=../../gst/invoices');
      const btext = await bad.evaluate(() => document.getElementById('inv-state').textContent);
      check('a link that is not a token is refused before anything is fetched', /incomplete/.test(btext), btext);
    }

    // ======================================================= the owner's screen
    {
      const O = await open('owner', 'admin.html', 'owner');
      await O.waitForFunction(() => document.getElementById('gst-health') && /Ready/.test(document.getElementById('gst-health').textContent), null, { timeout: 15000 })
        .catch(() => {});
      const health = await O.evaluate(() => document.getElementById('gst-health').textContent);
      check('the owner’s card says invoicing is ready, and for which account', /Ready/.test(health) && /HDFC Current/.test(health), health);
      const ticked = await O.evaluate((k) => { const el = document.querySelector('[data-gst-acct="' + k + '"]'); return el && el.checked; }, key(CURRENT));
      check('the current account is ticked', ticked === true);
      const badge = await O.evaluate(() => document.getElementById('upi-routing-list').textContent);
      check('and marked on its UPI Routing row', /GST invoices/.test(badge));
      check('the routing row shows the financial year against its yearly cap', /FY \d{4}-\d{2}: .* of ₹10,00,000/.test(badge), badge.slice(0, 300));

      // the register, and cancelling
      await O.evaluate(() => { const d = document.getElementById('gst-register-details'); d.open = true; d.dispatchEvent(new Event('toggle')); });
      await O.waitForFunction(() => document.querySelectorAll('#gst-reg-list button[data-gst="cancel"]').length > 0, null, { timeout: 5000 }).catch(() => {});
      const rows = await O.evaluate(() => document.querySelectorAll('#gst-reg-list tr').length);
      check('the register lists the month’s invoices', rows === invoices().length, rows + ' rows, ' + invoices().length + ' invoices');
      const target = invoices()[invoices().length - 1];
      await O.evaluate(() => { window.ilaAskText = () => Promise.resolve('customer wants a different name'); window.ilaAsk = () => Promise.resolve(true); window.ilaToast = () => {}; });
      await O.evaluate(([fy, seq]) => { const b = document.querySelector('#gst-reg-list button[data-gst="cancel"][data-fy="' + fy + '"][data-seq="' + seq + '"]'); if (b) b.click(); }, [target.fy, target.seq]);
      await quiet(800);
      const after = srv.get('gst/invoices/' + target.fy + '/' + target.seq);
      check('the owner can cancel an invoice, with a reason', after.status === 'cancelled' && after.cancelReason === 'customer wants a different name' && after.cancelledBy === 'Owner');
      check('it keeps its number, date and money', after.no === target.no && after.total === target.total && after.at === target.at);
      check('the customer’s link says it is cancelled', (srv.get('gst/public/' + target.token) || {}).status === 'cancelled');
      check('and the bill is free to be invoiced again', srv.get('gst/byBill/' + target.bill.key) === null);

      // the CSV the owner downloads is the one gst.js makes
      const csv = await O.evaluate(async () => { let out = null; const real = URL.createObjectURL; URL.createObjectURL = (b) => { out = b; return 'blob:x'; };
                                                 await window.gstDownloadCSV(); URL.createObjectURL = real; return out ? await out.text() : null; });
      check('the register downloads as a CSV, one row per invoice', !!csv && csv.trim().split('\r\n').length === invoices().length + 1);

      // business details are validated before they are saved
      await O.evaluate(() => { document.getElementById('gst-setup-details').open = true; });
      await O.fill('#gst-gstin', '05CPEPP3821F1Z5');
      await O.evaluate(() => window.gstSaveDetails());
      await quiet(300);
      check('a mistyped GSTIN is not saved', srv.get('gst/settings/gstin') === '05CPEPP3821F1Z4');

      // yearly cap, set from the routing row
      await O.evaluate((k) => window.upiSetYearCap(k, '1200000'), key(SAVINGS));
      await quiet(300);
      check('a yearly cap is set from the routing row', srv.get('upiRouting/config/' + key(SAVINGS) + '/yearlyCap') === 1200000);
    }

    check('no page threw', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
  } catch (e) {
    check('the suite ran to the end', false, (e && e.stack) || String(e));
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await browser.close();
    web.close();
    done();
  }
})();
