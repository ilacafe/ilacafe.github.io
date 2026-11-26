// GST INVOICES — the arithmetic, the numbering and the document, in one place.
//
// Loaded by the till (pos.html), the owner's screen (admin.html), the page a customer
// opens their invoice on (invoice.html), and bundled into the Worker that mails the
// month's invoices to the accountant. Four readers of one invoice, and an invoice is a
// legal document: if the till and the emailed copy disagreed about a paisa of CGST, one
// of them would be wrong on paper. So there is one implementation, as with qr.js.
//
// Nothing in here touches the database. Issuing an invoice is a write the rules have to
// police (an invoice number may be used once, and only the next one), and the access map
// that the rules are reviewed against is derived from the pages' own source — so the
// writes stay in the pages, where it can see them, and this file only does sums.
//
// THE PRICES ON THE MENU ALREADY INCLUDE GST. The till has never added tax to a bill,
// and the customer pays the bill's total — the bank credit the till matches is that
// number exactly. So an invoice does not add anything: it takes the total that was paid
// and says how much of it was tax.
(function (root) {
  'use strict';

  // GSTIN state codes. The first two digits of a GSTIN say where the business is
  // registered, and that is also the place of supply for a restaurant: IGST Act s.12(5)
  // puts it where the service is performed, so a café only ever charges CGST + SGST.
  var STATES = {
    '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
    '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
    '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
    '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
    '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
    '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
    '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
    '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
    '97': 'Other Territory'
  };

  // Restaurant service, including takeaway and delivery (SAC 996331), at 5% with no input
  // tax credit — the rate a standalone restaurant charges. Both are settings, these are
  // only what an empty setting means.
  var DEFAULT_SAC = '996331';
  var DEFAULT_RATE = 5;
  var DEFAULT_PREFIX = 'ILA';

  // ILA's registration, as its certificate states it (Form GST REG-06, issued 10/11/2026:
  // Regular, Proprietorship, principal place of business in Almora). None of it is
  // private — the GST portal shows it to anyone who searches the GSTIN, and it is printed
  // on every invoice — so it is what an empty setting means, and invoices can be issued
  // the moment the rules are live without anybody typing it in. Anything saved in
  // Admin → GST Invoices is laid over it.
  var DEFAULT_SETTINGS = {
    legalName: 'PRIYANSHU',
    tradeName: 'ILA',
    address: 'Kasar Devi, Almora Range, Almora, Uttarakhand 263601',
    gstin: '05CPEPP3821F1Z4',
    prefix: DEFAULT_PREFIX, sac: DEFAULT_SAC, rate: DEFAULT_RATE,
    mode: 'accounts',      // invoice the UPI payments into the ticked accounts
    autoMail: true         // and mail the month to the CA on the 1st
  };
  function effective(settings) {
    var out = {}, k;
    for (k in DEFAULT_SETTINGS) out[k] = DEFAULT_SETTINGS[k];
    if (settings && typeof settings === 'object') {
      for (k in settings) {
        var v = settings[k];
        if (v !== undefined && v !== null && v !== '') out[k] = v;
      }
    }
    return out;
  }

  var IST_MS = 5.5 * 3600 * 1000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function r2(n) { return Math.round(((parseFloat(n) || 0) + Number.EPSILON) * 100) / 100; }
  function money(n) { return r2(n).toFixed(2); }
  function inr(n) {
    var v = r2(n), neg = v < 0; v = Math.abs(v);
    var parts = v.toFixed(2).split('.'), w = parts[0];
    // Indian grouping: 12,34,567.00
    var last3 = w.slice(-3), rest = w.slice(0, -3);
    if (rest) last3 = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
    return (neg ? '-' : '') + '₹' + last3 + '.' + parts[1];
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------------------------------------------------------- dates, in India
  // The till's clock is a tablet in the café, but the Worker runs in UTC and an invoice
  // issued at 1am belongs to the day it was in Dehradun. So every date here is IST,
  // computed rather than taken from whatever zone the reader happens to be in.
  function ist(ms) {
    var d = new Date((parseFloat(ms) || 0) + IST_MS);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mi: d.getUTCMinutes() };
  }
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
  // The financial year, 1 April to 31 March: '2026-27'. Invoice numbers restart with it.
  function fyOf(ms) {
    var t = ist(ms), start = t.m >= 4 ? t.y : t.y - 1;
    return start + '-' + pad((start + 1) % 100);
  }
  function fyShort(fy) { var m = /^(\d{4})-(\d{2})$/.exec(String(fy || '')); return m ? m[1].slice(2) + '-' + m[2] : String(fy || ''); }
  function monthOf(ms) { var t = ist(ms); return t.y + '-' + pad(t.m); }
  function fyOfMonth(month) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(month || '')); if (!m) return null;
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), start = mo >= 4 ? y : y - 1;
    return start + '-' + pad((start + 1) % 100);
  }
  // [start, end) of a calendar month in IST, as epoch ms.
  function monthRange(month) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(month || '')); if (!m) return null;
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10);
    var start = Date.UTC(y, mo - 1, 1) - IST_MS, end = Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) - IST_MS;
    return { start: start, end: end };
  }
  function prevMonth(ms) { var t = ist(ms); return t.m === 1 ? (t.y - 1) + '-12' : t.y + '-' + pad(t.m - 1); }
  function monthLabel(month) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(month || '')); if (!m) return String(month || '');
    return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][parseInt(m[2], 10) - 1] + ' ' + m[1];
  }
  function dateText(ms) { var t = ist(ms); return pad(t.d) + '-' + pad(t.m) + '-' + t.y; }
  function dateTimeText(ms) { var t = ist(ms); return t.d + ' ' + MONTHS[t.m - 1] + ' ' + t.y + ', ' + pad(t.hh) + ':' + pad(t.mi); }

  // ---------------------------------------------------------------- numbering
  // Rule 46(b): a consecutive serial, unique for the financial year, at most 16
  // characters of letters, digits, '-' and '/'. PREFIX/YY-YY/NNNN is 15 with a
  // four-letter prefix and four digits, and stays inside 16 up to 99,999 a year.
  function cleanPrefix(p) {
    var s = String(p == null ? '' : p).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    return s || DEFAULT_PREFIX;
  }
  function invoiceNo(prefix, fy, seq) {
    return cleanPrefix(prefix) + '/' + fyShort(fy) + '/' + pad(parseInt(seq, 10) || 0, 4);
  }

  // ---------------------------------------------------------------- GSTIN
  // 2 digits of state, a 10-character PAN, the entity number, 'Z', and a check
  // character. The check character is a mod-36 sum over the first fourteen, so a
  // transposed or mistyped character is caught before it is printed on an invoice
  // the customer's accountant will reject.
  var GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function gstinCheckChar(first14) {
    var sum = 0;
    for (var i = 0; i < 14; i++) {
      var v = GSTIN_CHARS.indexOf(first14.charAt(i));
      if (v < 0) return null;
      var p = v * (i % 2 === 0 ? 1 : 2);
      sum += Math.floor(p / 36) + (p % 36);
    }
    return GSTIN_CHARS.charAt((36 - (sum % 36)) % 36);
  }
  function normGSTIN(g) { return String(g == null ? '' : g).toUpperCase().replace(/\s+/g, ''); }
  function validGSTIN(g) {
    g = normGSTIN(g);
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
    if (!STATES[g.slice(0, 2)] && g.slice(0, 2) !== '99') return false;
    return gstinCheckChar(g.slice(0, 14)) === g.charAt(14);
  }
  function stateOf(gstin) {
    var code = normGSTIN(gstin).slice(0, 2);
    return { code: code, name: STATES[code] || '' };
  }

  // ---------------------------------------------------------------- the tax in a price
  // CGST and SGST are each half the rate, and each is rounded once, so the two halves
  // are always equal; the taxable value is what is left. That way taxable + CGST + SGST
  // is the total to the paisa, which is the one line an accountant adds up first.
  function taxSplit(total, rate) {
    total = r2(total);
    rate = parseFloat(rate); if (!(rate >= 0)) rate = DEFAULT_RATE;
    var half = r2(total * (rate / 2) / (100 + rate));
    return { total: total, rate: rate, cgst: half, sgst: half, igst: 0, tax: r2(half * 2), taxable: r2(total - half * 2) };
  }

  // A bill's items, as the till stores them: { "Latte + Oat": { qty, price, ... } }.
  function linesOf(items) {
    var out = [];
    if (!items) return out;
    var keys = Array.isArray(items) ? items.map(function (_, i) { return i; }) : Object.keys(items);
    keys.forEach(function (k) {
      var it = items[k]; if (!it) return;
      var q = parseFloat(it.qty) || 0, r = parseFloat(it.price) || 0;
      if (q <= 0) return;
      var name = Array.isArray(items) ? (it.n || it.name || '') : k;
      out.push({ n: String(name).slice(0, 80), q: q, r: r2(r), a: r2(q * r) });
    });
    return out;
  }

  function clean(o) {
    if (Array.isArray(o)) return o.map(clean);
    if (!o || typeof o !== 'object') return o;
    var out = {};
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (v === undefined || v === null || v === '') return;
      if (typeof v === 'object') { v = clean(v); if (!Array.isArray(v) && !Object.keys(v).length) return; }
      out[k] = v;
    });
    return out;
  }

  // The seller's block, from the settings. Copied onto every invoice when it is issued,
  // because an invoice states the business as it was on the day: an address changed in
  // the settings next year must not rewrite invoices already sent.
  function sellerOf(settings) {
    settings = settings || {};
    var gstin = normGSTIN(settings.gstin);
    var st = stateOf(gstin);
    return clean({
      legal: String(settings.legalName || '').trim().slice(0, 120),
      trade: String(settings.tradeName || '').trim().slice(0, 120),
      address: String(settings.address || '').trim().slice(0, 300),
      gstin: gstin,
      stateCode: st.code,
      state: st.name,
      phone: String(settings.phone || '').trim().slice(0, 30),
      email: String(settings.email || '').trim().slice(0, 120)
    });
  }
  // What is missing before an invoice can be issued at all. An invoice without the
  // seller's legal name, address or GSTIN is not a tax invoice.
  function settingsProblems(settings) {
    settings = settings || {};
    var out = [];
    if (!String(settings.legalName || '').trim()) out.push('the legal name of the business');
    if (!String(settings.address || '').trim()) out.push('the business address');
    if (!validGSTIN(settings.gstin)) out.push('a valid GSTIN');
    return out;
  }

  // buyer: { name, gstin, address, phone } — all optional. Rule 46(e): for an
  // unregistered buyer, name and address are required only from ₹50,000.
  function buyerProblems(buyer, total) {
    buyer = buyer || {};
    var out = [];
    if (buyer.gstin && !validGSTIN(buyer.gstin)) out.push('that GSTIN does not check out — look at it again');
    if (buyer.gstin && !String(buyer.name || '').trim()) out.push('a GSTIN needs the business name with it');
    if (r2(total) >= 50000 && (!String(buyer.name || '').trim() || !String(buyer.address || '').trim()))
      out.push('an invoice of ₹50,000 or more needs the customer’s name and address');
    return out;
  }

  // The invoice, minus the number, the token and the moment of issue, which the page
  // that writes it assigns. opts:
  //   settings  gst/settings
  //   items     the bill's items, as the till stores them
  //   total     what was paid for them (the bill total — a tip is not part of the supply)
  //   bill      { key, label, source, at }
  //   pay       { method, vpa }
  //   buyer     { name, gstin, address, phone }
  //   how       'auto' | 'asked'
  //   by        who issued it
  function draft(opts) {
    opts = opts || {};
    var settings = opts.settings || {};
    var rate = parseFloat(settings.rate); if (!(rate >= 0 && rate <= 28)) rate = DEFAULT_RATE;
    var sac = String(settings.sac || DEFAULT_SAC).replace(/\D/g, '').slice(0, 8) || DEFAULT_SAC;
    var lines = linesOf(opts.items);
    var gross = r2(lines.reduce(function (a, l) { return a + l.a; }, 0));
    var total = r2(opts.total != null ? opts.total : gross);
    var tax = taxSplit(total, rate);
    var buyer = opts.buyer || {};
    var seller = sellerOf(settings);
    return clean({
      billAt: opts.bill && opts.bill.at,
      bill: opts.bill ? { key: opts.bill.key, label: String(opts.bill.label || '').slice(0, 120), source: opts.bill.source } : null,
      items: lines,
      gross: gross,
      adjust: r2(total - gross) || null,          // a bill whose total is not its lines
      total: tax.total, taxable: tax.taxable, cgst: tax.cgst, sgst: tax.sgst, igst: 0,
      rate: rate, sac: sac,
      pos: { code: seller.stateCode, name: seller.state },   // place of supply: the café
      pay: opts.pay ? { method: String(opts.pay.method || '').slice(0, 30), vpa: opts.pay.vpa || null } : null,
      buyer: {
        name: String(buyer.name || '').trim().slice(0, 120),
        gstin: normGSTIN(buyer.gstin).slice(0, 15),
        address: String(buyer.address || '').trim().slice(0, 300),
        phone: String(buyer.phone || '').replace(/[^\d+]/g, '').slice(0, 15)
      },
      seller: seller,
      how: opts.how === 'auto' ? 'auto' : 'asked',
      by: String(opts.by || '').slice(0, 60),
      status: 'issued'
    });
  }

  // 20 characters of [A-Za-z0-9]: ~119 bits. The customer's link is this token and
  // nothing else, and the public copy can only be read by somebody who has it.
  function token() {
    var a = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', out = '';
    var b = new Uint8Array(20);
    (root.crypto || (typeof crypto !== 'undefined' ? crypto : null)).getRandomValues(b);
    for (var i = 0; i < b.length; i++) out += a.charAt(b[i] % 62);
    return out;
  }

  // What the customer's link can read. Their own name and GSTIN are on it — that is
  // the point of asking for an invoice — but not their phone number, who at the café
  // issued it, which of the café's accounts the money went to, or the bill's key.
  function publicCopy(inv) {
    var c = JSON.parse(JSON.stringify(inv || {}));
    delete c.by;
    if (c.buyer) { delete c.buyer.phone; if (!Object.keys(c.buyer).length) delete c.buyer; }
    if (c.pay) delete c.pay.vpa;
    if (c.bill) delete c.bill.key;
    return c;
  }

  // ---------------------------------------------------------------- in words
  // Indian invoices state the total in words, in lakhs and crores.
  var ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven',
              'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  var TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function two(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''); }
  function three(n) { var h = Math.floor(n / 100), r = n % 100; return (h ? ONES[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? two(r) : ''); }
  function wholeWords(n) {
    if (n === 0) return 'Zero';
    var out = [], crore = Math.floor(n / 10000000); n %= 10000000;
    var lakh = Math.floor(n / 100000); n %= 100000;
    var thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) out.push(wholeWords(crore) + ' Crore');
    if (lakh) out.push(two(lakh) + ' Lakh');
    if (thousand) out.push(two(thousand) + ' Thousand');
    if (n) out.push(three(n));
    return out.join(' ');
  }
  function words(amount) {
    var v = r2(Math.abs(amount)), rupees = Math.floor(v), paise = Math.round((v - rupees) * 100);
    return 'Rupees ' + wholeWords(rupees) + (paise ? ' and ' + two(paise) + ' Paise' : '') + ' Only';
  }

  // ---------------------------------------------------------------- the document
  // A white page, whatever the screen around it is: an invoice is paper, it is printed
  // and saved as PDF, and the café's brown would print as a slab of ink. Every class is
  // prefixed so it can sit inside another page without either restyling the other.
  var CSS = [
    '.gi{background:#fff;color:#111;font-family:"Helvetica Neue",Arial,sans-serif;font-size:13px;line-height:1.45;max-width:760px;margin:0 auto;padding:28px 30px;box-sizing:border-box;border:1px solid #ddd;position:relative}',
    '.gi *{box-sizing:border-box}',
    '.gi h1{font-size:18px;letter-spacing:3px;text-align:center;margin:0 0 14px;font-weight:700}',
    '.gi-top{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:12px}',
    '.gi-seller b{font-size:15px}',
    '.gi-meta{text-align:right}',
    '.gi-meta div,.gi-seller div,.gi-buyer div{margin:1px 0}',
    '.gi-k{color:#555}',
    '.gi-buyer{border:1px solid #ccc;border-radius:4px;padding:8px 10px;margin-bottom:12px}',
    '.gi table{width:100%;border-collapse:collapse;margin:6px 0}',
    '.gi th,.gi td{border-bottom:1px solid #ddd;padding:6px 6px;text-align:left;vertical-align:top}',
    '.gi th{background:#f3f3f3;font-size:11px;text-transform:uppercase;letter-spacing:.5px}',
    '.gi .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.gi-sum{margin-left:auto;width:min(340px,100%)}',
    '.gi-sum td{border:none;padding:3px 6px}',
    '.gi-sum tr.gi-tot td{border-top:2px solid #111;font-weight:700;font-size:15px;padding-top:6px}',
    '.gi-words{margin:8px 0 14px;font-style:italic}',
    '.gi-foot{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-top:22px;font-size:12px;color:#333}',
    '.gi-sign{text-align:right;min-width:200px}',
    '.gi-sign .gi-line{margin-top:34px;border-top:1px solid #111;padding-top:4px}',
    '.gi-void{border:3px solid #b00020;color:#b00020;font-weight:700;letter-spacing:4px;text-align:center;padding:8px;margin-bottom:14px;font-size:16px}',
    '.gi-void small{display:block;letter-spacing:0;font-weight:400;font-size:12px;margin-top:2px}',
    // On a phone the number and date drop under the business; right-aligned there they
    // read as stranded, so they line up with it instead.
    '@media (max-width:520px){.gi{padding:20px 16px}.gi-meta{text-align:left}}',
    '@media print{.gi{border:none;max-width:none;padding:0}.gi-page{page-break-after:always;break-after:page}.gi-page:last-child{page-break-after:auto;break-after:auto}}'
  ].join('\n');

  function render(inv) {
    inv = inv || {};
    var s = inv.seller || {}, b = inv.buyer || {};
    // An array, as written. Read back over REST it is an array again when it is dense,
    // which an invoice's lines always are — but a list that came back as {"0": …} is
    // still the same lines, and a document that refused to print over it would be worse.
    var lines = Array.isArray(inv.items) ? inv.items : Object.keys(inv.items || {}).map(function (k) { return inv.items[k]; });
    var h = '<article class="gi">';
    if (inv.status === 'cancelled') {
      h += '<div class="gi-void">CANCELLED<small>' + esc(inv.cancelReason || '') +
           (inv.cancelledAt ? ' · ' + esc(dateTimeText(inv.cancelledAt)) : '') + '</small></div>';
    }
    h += '<h1>TAX INVOICE</h1>';
    h += '<div class="gi-top"><div class="gi-seller">';
    h += '<div><b>' + esc(s.trade || s.legal || '') + '</b></div>';
    if (s.trade && s.legal && s.trade !== s.legal) h += '<div>' + esc(s.legal) + '</div>';
    if (s.address) h += '<div>' + esc(s.address).replace(/\n/g, '<br>') + '</div>';
    h += '<div><span class="gi-k">GSTIN:</span> <b>' + esc(s.gstin || '') + '</b></div>';
    if (s.state) h += '<div><span class="gi-k">State:</span> ' + esc(s.state) + ' (' + esc(s.stateCode || '') + ')</div>';
    if (s.phone || s.email) h += '<div>' + esc([s.phone, s.email].filter(Boolean).join(' · ')) + '</div>';
    h += '</div><div class="gi-meta">';
    h += '<div><span class="gi-k">Invoice no.</span> <b>' + esc(inv.no || '') + '</b></div>';
    h += '<div><span class="gi-k">Date</span> ' + esc(inv.at ? dateText(inv.at) : '') + '</div>';
    if (inv.bill && inv.bill.label) h += '<div><span class="gi-k">Bill</span> ' + esc(inv.bill.label) + '</div>';
    if (inv.billAt && inv.at && dateText(inv.billAt) !== dateText(inv.at)) h += '<div><span class="gi-k">Served</span> ' + esc(dateTimeText(inv.billAt)) + '</div>';
    var pos = inv.pos || {};
    h += '<div><span class="gi-k">Place of supply</span> ' + esc(pos.name || s.state || '') + (pos.code || s.stateCode ? ' (' + esc(pos.code || s.stateCode) + ')' : '') + '</div>';
    h += '<div><span class="gi-k">Reverse charge</span> No</div>';
    h += '</div></div>';

    if (b.name || b.gstin || b.address) {
      h += '<div class="gi-buyer"><div class="gi-k">Billed to</div>';
      if (b.name) h += '<div><b>' + esc(b.name) + '</b></div>';
      if (b.address) h += '<div>' + esc(b.address).replace(/\n/g, '<br>') + '</div>';
      if (b.gstin) h += '<div><span class="gi-k">GSTIN:</span> <b>' + esc(b.gstin) + '</b> · ' + esc(stateOf(b.gstin).name) + '</div>';
      h += '</div>';
    }

    h += '<table><thead><tr><th style="width:32px;">#</th><th>Description</th><th>SAC</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody>';
    lines.forEach(function (l, i) {
      h += '<tr><td>' + (i + 1) + '</td><td>' + esc(l.n) + '</td><td>' + esc(inv.sac || DEFAULT_SAC) + '</td><td class="n">' + esc(l.q) + '</td><td class="n">' + money(l.r) + '</td><td class="n">' + money(l.a) + '</td></tr>';
    });
    if (!lines.length) h += '<tr><td>1</td><td>Restaurant service</td><td>' + esc(inv.sac || DEFAULT_SAC) + '</td><td class="n">1</td><td class="n">' + money(inv.total) + '</td><td class="n">' + money(inv.total) + '</td></tr>';
    h += '</tbody></table>';

    var half = r2((parseFloat(inv.rate) || 0) / 2);
    h += '<table class="gi-sum"><tbody>';
    if (inv.adjust) {
      h += '<tr><td>Items</td><td class="n">' + money(inv.gross) + '</td></tr>';
      h += '<tr><td>' + (inv.adjust < 0 ? 'Less: adjustment' : 'Add: other charges') + '</td><td class="n">' + money(inv.adjust) + '</td></tr>';
    }
    h += '<tr><td>Taxable value</td><td class="n">' + money(inv.taxable) + '</td></tr>';
    h += '<tr><td>CGST @ ' + half + '%</td><td class="n">' + money(inv.cgst) + '</td></tr>';
    h += '<tr><td>SGST @ ' + half + '%</td><td class="n">' + money(inv.sgst) + '</td></tr>';
    h += '<tr class="gi-tot"><td>Total</td><td class="n">' + esc(inr(inv.total)) + '</td></tr>';
    h += '</tbody></table>';
    h += '<div class="gi-words">' + esc(words(inv.total)) + '</div>';
    h += '<div style="font-size:12px;">Prices include GST. ' + (inv.pay && inv.pay.method ? 'Paid by ' + esc(inv.pay.method) + '.' : '') + '</div>';
    h += '<div class="gi-foot"><div>This is a computer-generated invoice.</div>';
    h += '<div class="gi-sign">For ' + esc(s.trade || s.legal || '') + '<div class="gi-line">Authorised signatory</div></div></div>';
    h += '</article>';
    return h;
  }

  function summary(invs) {
    var out = { count: 0, issued: 0, cancelled: 0, first: null, last: null, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0, b2b: 0, b2c: 0 };
    (invs || []).slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); }).forEach(function (inv) {
      if (!inv) return;
      out.count++;
      if (out.first === null) out.first = inv.no; out.last = inv.no;
      if (inv.status === 'cancelled') { out.cancelled++; return; }
      out.issued++;
      if (inv.buyer && inv.buyer.gstin) out.b2b++; else out.b2c++;
      out.taxable = r2(out.taxable + (parseFloat(inv.taxable) || 0));
      out.cgst = r2(out.cgst + (parseFloat(inv.cgst) || 0));
      out.sgst = r2(out.sgst + (parseFloat(inv.sgst) || 0));
      out.igst = r2(out.igst + (parseFloat(inv.igst) || 0));
      out.total = r2(out.total + (parseFloat(inv.total) || 0));
    });
    return out;
  }

  // Every invoice of a period, printable, one to a page, after a page that adds them up.
  // This is what goes to the accountant, and what the owner downloads.
  function book(invs, opts) {
    opts = opts || {};
    var list = (invs || []).slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
    var sm = summary(list);
    var seller = (list[0] && list[0].seller) || opts.seller || {};
    var title = 'GST invoices — ' + (opts.title || '');
    var h = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    h += '<title>' + esc(title) + '</title><style>body{margin:0;padding:16px;background:#eee;font-family:Arial,sans-serif;color:#111}' +
         '.gi-page{margin:0 auto 16px}.gi-cover h2{margin:0 0 10px;font-size:18px}' + CSS +
         '@media print{body{background:#fff;padding:0}}</style></head><body>';
    h += '<section class="gi-page"><article class="gi gi-cover"><h2>' + esc(title) + '</h2>';
    h += '<div>' + esc(seller.trade || seller.legal || '') + (seller.gstin ? ' · GSTIN ' + esc(seller.gstin) : '') + '</div>';
    h += '<table><tbody>';
    h += '<tr><td>Invoices issued</td><td class="n">' + sm.issued + '</td></tr>';
    h += '<tr><td>Cancelled</td><td class="n">' + sm.cancelled + '</td></tr>';
    h += '<tr><td>Serial numbers</td><td class="n">' + (sm.first ? esc(sm.first) + ' to ' + esc(sm.last) : '—') + '</td></tr>';
    h += '<tr><td>To registered buyers (B2B)</td><td class="n">' + sm.b2b + '</td></tr>';
    h += '<tr><td>To consumers (B2C)</td><td class="n">' + sm.b2c + '</td></tr>';
    h += '<tr><td>Taxable value</td><td class="n">' + money(sm.taxable) + '</td></tr>';
    h += '<tr><td>CGST</td><td class="n">' + money(sm.cgst) + '</td></tr>';
    h += '<tr><td>SGST</td><td class="n">' + money(sm.sgst) + '</td></tr>';
    h += '<tr><td><b>Total</b></td><td class="n"><b>' + money(sm.total) + '</b></td></tr>';
    h += '</tbody></table>';
    if (!list.length) h += '<p>No invoices were issued in this period.</p>';
    h += '<p style="font-size:12px;color:#555;">Cancelled invoices are included and marked, so the serial numbers run without a gap. Totals exclude them.</p>';
    h += '</article></section>';
    list.forEach(function (inv) { h += '<section class="gi-page">' + render(inv) + '</section>'; });
    h += '</body></html>';
    return h;
  }

  // One row per invoice: the register the accountant files from.
  var CSV_HEAD = ['Invoice No', 'Invoice Date', 'Status', 'Buyer Name', 'Buyer GSTIN', 'Type', 'Place of Supply',
                  'SAC', 'Rate %', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Invoice Total', 'Bill', 'Bill Date',
                  'Payment', 'UPI Account', 'Issued', 'Cancelled On', 'Cancel Reason'];
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    // A leading = + - @ makes a spreadsheet run the cell as a formula.
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csv(invs) {
    var rows = [CSV_HEAD];
    (invs || []).slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); }).forEach(function (inv) {
      if (!inv) return;
      var b = inv.buyer || {}, pos = inv.pos || {}, cancelled = inv.status === 'cancelled';
      rows.push([
        inv.no, inv.at ? dateText(inv.at) : '', cancelled ? 'Cancelled' : 'Issued',
        b.name || '', b.gstin || '', b.gstin ? 'B2B' : 'B2C',
        (pos.code ? pos.code + '-' : '') + (pos.name || ''),
        inv.sac || '', inv.rate, money(inv.taxable), money(inv.cgst), money(inv.sgst), money(inv.igst || 0), money(inv.total),
        (inv.bill && inv.bill.label) || '', inv.billAt ? dateTimeText(inv.billAt) : '',
        (inv.pay && inv.pay.method) || '', (inv.pay && inv.pay.vpa) || '',
        inv.how === 'auto' ? 'Automatic' : 'On request' + (inv.by ? ' (' + inv.by + ')' : ''),
        cancelled && inv.cancelledAt ? dateText(inv.cancelledAt) : '', cancelled ? (inv.cancelReason || '') : ''
      ]);
    });
    // The byte-order mark is what makes Excel read the file as UTF-8 rather than
    // mangling a customer's name.
    return '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  var api = {
    STATES: STATES, DEFAULT_SAC: DEFAULT_SAC, DEFAULT_RATE: DEFAULT_RATE, DEFAULT_PREFIX: DEFAULT_PREFIX, CSS: CSS,
    r2: r2, money: money, inr: inr, esc: esc,
    fyOf: fyOf, fyShort: fyShort, fyOfMonth: fyOfMonth, monthOf: monthOf, monthRange: monthRange,
    prevMonth: prevMonth, monthLabel: monthLabel, dateText: dateText, dateTimeText: dateTimeText,
    cleanPrefix: cleanPrefix, invoiceNo: invoiceNo,
    normGSTIN: normGSTIN, validGSTIN: validGSTIN, gstinCheckChar: gstinCheckChar, stateOf: stateOf,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS, effective: effective,
    taxSplit: taxSplit, linesOf: linesOf, sellerOf: sellerOf, settingsProblems: settingsProblems,
    buyerProblems: buyerProblems, draft: draft, token: token, publicCopy: publicCopy, words: words,
    render: render, summary: summary, book: book, csv: csv
  };
  root.IlaGST = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
