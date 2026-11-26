// The monthly GST email to the accountant, as the Worker sends it.
//
// Lifted out of worker/worker.js rather than copied, so a rename fails here. The
// database and the mail binding are stubs; the invoices, the sums and the document
// are the real gst.js, because that is what the accountant receives.

const path = require('path');
const { ROOT, readPage, extractFunction, buildModule, suite } = require('./helpers');
const G = require(path.join(ROOT, 'gst.js'));
const { check, note, done } = suite('GST invoices — the monthly email to the accountant');

const src = readPage('worker/worker.js');
const consts = ['GST_MAIL_HOUR_IST', 'GST_MAIL_LAST_DAY', 'GST_MAIL_RETRY_MS', 'GST_BOOK_MAX_CHARS', 'GST_EMAIL_RE']
  .map(n => { const m = new RegExp('^const ' + n + '\\s*=.*$', 'm').exec(src); if (!m) throw new Error('no ' + n); return m[0]; });
const FNS = ['gstMailWindow', 'gstB64', 'gstHeader', 'gstMime', 'gstLoadMonth', 'gstMonthMessage', 'gstSendMonth', 'runGstMonthlyMail'];
const IST = 5.5 * 3600 * 1000;

const SETTINGS = { legalName: 'Legal Name', tradeName: 'ILA', address: 'Rajpur Road, Dehradun', gstin: '05CPEPP3821F1Z4',
                   email: 'hello@ila.test', caEmail: 'ca@example.test', autoMail: true };
function invoice(seq, extra) {
  return Object.assign(G.draft({ settings: SETTINGS, items: { Latte: { qty: 1, price: 450 } }, total: 450,
                                 bill: { key: 'b' + seq, label: 'Table ' + seq }, pay: { method: 'UPI', vpa: 'ila@hdfc' }, how: 'auto' }),
                       { no: G.invoiceNo('ILA', '2026-27', seq), seq, fy: '2026-27', at: Date.UTC(2026, 10, 10), token: 't' + seq },
                       extra || {});
}

function load(opts) {
  opts = opts || {};
  const state = { sent: [], logged: {}, fetched: [], invoices: opts.invoices || {}, mailLog: opts.mailLog || {} };
  const globals = {
    IlaGST: G, IST_OFFSET_MS: IST, _enc: new TextEncoder(), crypto: globalThis.crypto, btoa: globalThis.btoa,
    DB_URL: 'https://db.test', console: { log() {} },
    GST_MAIL: opts.binding === undefined ? { send: async (m) => { if (opts.refuse) throw new Error(opts.refuse); state.sent.push(m); } } : opts.binding,
    GST_MAIL_FROM: opts.from === undefined ? 'invoices@ila.test' : opts.from,
    EmailMessage: function (from, to, raw) { this.from = from; this.to = to; this.raw = raw; },
    getRobotToken: async () => 'tok',
    monLoad: async (t, p) => (p === '/gst/settings' ? (opts.settings === undefined ? SETTINGS : opts.settings) : null),
    dbPut: async (p, body) => { state.logged[p] = body; return { ok: true }; },
    safeText: (v, n) => String(v).slice(0, n),
    fetch: async (url) => {
      state.fetched.push(url);
      if (/\/gst\/invoices\//.test(url)) return { ok: true, json: async () => state.invoices };
      const m = /\/gst\/mailLog\/(\d{4}-\d{2})\.json/.exec(url);
      if (m) return { ok: true, json: async () => state.mailLog[m[1]] || null };
      return { ok: false, status: 404, json: async () => null };
    },
  };
  const mod = buildModule(consts.concat(FNS.map(n => extractFunction(src, n))), globals, FNS);
  return { mod, state };
}

function decodePart(raw, name) {
  const at = raw.indexOf('filename="' + name + '"');
  if (at < 0) return null;
  const body = raw.slice(raw.indexOf('\r\n\r\n', at) + 4);
  const b64 = body.slice(0, body.indexOf('\r\n--')).replace(/\r\n/g, '');
  return Buffer.from(b64, 'base64').toString('utf8');
}

(async () => {
  // ------------------------------------------------------------- when it goes
  {
    const { mod } = load();
    const at = (d, h, m) => Date.UTC(2026, 11, d, h, m || 0) - IST;      // December, IST wall clock
    check('not before 10am on the 1st', !mod.gstMailWindow(at(1, 9, 59)));
    check('from 10am on the 1st', mod.gstMailWindow(at(1, 10, 0)));
    check('and catching up until the 7th', mod.gstMailWindow(at(4, 3)) && mod.gstMailWindow(at(7, 23)));
    check('but not after it', !mod.gstMailWindow(at(8, 10)) && !mod.gstMailWindow(at(28, 10)));
    check('the 1st is the 1st in India, not in UTC',
          mod.gstMailWindow(Date.UTC(2026, 10, 30, 20, 0)) === false && mod.gstMailWindow(Date.UTC(2026, 11, 1, 4, 30)) === true);
  }

  // ------------------------------------------------------------- what it sends
  {
    const invs = { 1: invoice(1), 2: invoice(2, { buyer: { name: 'Acme Pvt Ltd', gstin: '05CPEPP3821F1Z4' } }), 3: invoice(3, { status: 'cancelled' }) };
    const { mod, state } = load({ invoices: invs });
    const r = await mod.gstSendMonth('tok', SETTINGS, '2026-11', 'asked', 'Owner', Date.UTC(2026, 11, 1, 5));
    check('a month with invoices is sent', r.ok && state.sent.length === 1, JSON.stringify(r));
    const msg = state.sent[0];
    check('from the café\'s address, to the CA', msg.from === 'invoices@ila.test' && msg.to === 'ca@example.test');
    check('counting the invoices issued, not the cancelled one', r.count === 2);
    check('the month is read by the date index, between its IST midnights',
          state.fetched.some(u => u.indexOf('/gst/invoices/2026-27.json?orderBy=%22at%22&startAt=' + G.monthRange('2026-11').start) >= 0));
    const raw = msg.raw;
    check('the message has a subject, a date and a Message-ID', /\r\nSubject: /.test(raw) && /\r\nDate: /.test(raw) && /\r\nMessage-ID: <[0-9a-f]+@ila\.test>/.test(raw));
    check('replies go to the café, not to the sending address', /\r\nReply-To: <hello@ila\.test>/.test(raw));
    const csv = decodePart(raw, 'ILA-GST-invoices-2026-11.csv');
    check('the register is attached and decodes to the CSV gst.js makes', csv === G.csv(Object.values(invs)));
    const book = decodePart(raw, 'ILA-GST-invoices-2026-11.html');
    check('and every invoice, printable, in one file', !!book && (book.match(/class="gi-page"/g) || []).length === 4);
    check('the body says what the month came to', /Total: ₹900\.00/.test(Buffer.from(raw.split('Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8')));
    check('and what was done is written down', state.logged['/gst/mailLog/2026-11'] && state.logged['/gst/mailLog/2026-11'].ok === true &&
          state.logged['/gst/mailLog/2026-11'].count === 2 && state.logged['/gst/mailLog/2026-11'].how === 'asked');
    check('no base64 line is longer than 76 characters', raw.split('\r\n').every(l => l.length <= 998) &&
          raw.split('\r\n').filter(l => /^[A-Za-z0-9+/=]{20,}$/.test(l)).every(l => l.length <= 76));
  }

  // ------------------------------------------------------------- an empty month
  {
    const { mod, state } = load({ invoices: {} });
    const r = await mod.gstSendMonth('tok', SETTINGS, '2026-10', 'auto', null, Date.UTC(2026, 10, 1, 5));
    check('a month with no invoices is still reported — a nil month is an answer too', r.ok && r.count === 0);
    const text = Buffer.from(state.sent[0].raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8');
    check('and says so', /No invoices were issued this month/.test(text));
  }

  // ------------------------------------------------------------- headers
  {
    const { mod } = load();
    check('a header can never carry a line break', mod.gstHeader('a\r\nBcc: x@y.z').indexOf('\n') < 0);
    check('anything outside ASCII is encoded', /^=\?UTF-8\?B\?/.test(mod.gstHeader('ILA — invoices')));
    const raw = mod.gstMime({ from: 'a@b.c', to: 'c@d.e', subject: 'x\r\nBcc: evil@x.y', text: 't', html: 'h',
                              attachments: [{ name: 'a"b\r\n.csv', type: 'text/csv', content: 'x' }] });
    check('so a subject cannot add a recipient', !/\r\nBcc:/.test(raw));
    check('nor can a file name', raw.indexOf('filename="a_b__.csv"') >= 0);
  }

  // ------------------------------------------------------------- when it cannot
  {
    const { mod, state } = load({ binding: null });
    const r = await mod.gstSendMonth('tok', SETTINGS, '2026-11', 'auto', null, 1);
    check('no mail binding: it says so and sends nothing', !r.ok && /GST_MAIL binding/.test(r.error) && state.sent.length === 0);
    check('and writes that down for the owner\'s card', state.logged['/gst/mailLog/2026-11'] && state.logged['/gst/mailLog/2026-11'].ok === false);
  }
  {
    const { mod } = load({ from: '' });
    const r = await mod.gstSendMonth('tok', SETTINGS, '2026-11', 'auto', null, 1);
    check('no sending address: likewise', !r.ok && /GST_MAIL_FROM/.test(r.error));
  }
  {
    const { mod } = load();
    const r = await mod.gstSendMonth('tok', Object.assign({}, SETTINGS, { caEmail: 'not an address' }), '2026-11', 'auto', null, 1);
    check('no valid CA address: likewise', !r.ok && /CA email/.test(r.error));
  }
  {
    const { mod, state } = load({ refuse: 'destination address not verified' });
    const r = await mod.gstSendMonth('tok', SETTINGS, '2026-11', 'auto', null, 1);
    check('a refused send is reported with what to do about it', !r.ok && /verified destination/.test(r.error), r.error);
    check('and recorded as not sent', state.logged['/gst/mailLog/2026-11'].ok === false);
  }

  // ------------------------------------------------------------- the schedule
  const DEC1 = Date.UTC(2026, 11, 1, 5);   // 10:30 IST on 1 December
  {
    const { mod, state } = load({ settings: Object.assign({}, SETTINGS, { autoMail: false }) });
    const r = await mod.runGstMonthlyMail(DEC1);
    check('the schedule does nothing while the monthly email is off', r.skipped === 'off' && state.sent.length === 0);
  }
  {
    const { mod, state } = load({ mailLog: { '2026-11': { ok: true, at: DEC1 - 60000 } } });
    const r = await mod.runGstMonthlyMail(DEC1 + 3600000);
    check('it sends last month, once', r.skipped === 'already sent' && state.sent.length === 0);
  }
  {
    const { mod, state } = load({ mailLog: { '2026-11': { ok: false, at: DEC1 - 60000 } } });
    const r = await mod.runGstMonthlyMail(DEC1);
    check('a month that just failed waits before it is tried again', r.skipped === 'tried recently' && state.sent.length === 0);
  }
  {
    const { mod, state } = load({ invoices: { 1: invoice(1) }, mailLog: { '2026-11': { ok: false, at: DEC1 - 4 * 3600000 } } });
    const r = await mod.runGstMonthlyMail(DEC1);
    check('and is tried again after three hours', r.ok && state.sent.length === 1 && r.month === '2026-11');
  }
  {
    const { mod } = load({ binding: null });
    let threw = null;
    try { await mod.runGstMonthlyMail(DEC1); } catch (e) { threw = e; }
    check('a scheduled send that fails throws, so the owner is pushed about it', !!threw && /November 2026/.test(threw.message));
  }
  {
    const s = readPage('worker/worker.js');
    check('the hourly tick only runs it inside its window',
          /if \(gstMailWindow\(now\)\) ctx\.waitUntil\(reportIfItThrows\('gst-mail', runGstMonthlyMail\(now\), false\)\)/.test(s));
    check('the owner\'s "now" is admin only',
          /data\.action === 'gst-mail'[\s\S]{0,500}\(await staffRoleOf\(who\.sub\)\) !== 'admin'/.test(s));
  }
  note('Email Routing only delivers to verified destinations — that is the outside safeguard');

  done();
})();
