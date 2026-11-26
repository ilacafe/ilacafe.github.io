// The job that readies the monthly GST email without anybody at the Cloudflare
// dashboard (tools/gst-mail-setup.js).
//
// It runs in a public repository's Actions, so its log is public. The property held
// here above all others: the CA's address, which the owner chose to keep private, is
// masked when it is read and never appears in a log line or in what it writes back.

const path = require('path');
const { ROOT, suite } = require('./helpers');
const { run } = require(path.join(ROOT, 'tools', 'gst-mail-setup.js'));
const { check, note, done } = suite('GST mail setup — the sending domain and the CA’s address, unattended');

const CA = 'ca.person@example.test';
const CF_MX = [{ exchange: 'route1.mx.cloudflare.net', priority: 10 }, { exchange: 'route2.mx.cloudflare.net', priority: 20 }];

function harness(o) {
  o = o || {};
  const st = { logs: [], masked: [], dbWrites: {}, cfCalls: [], dbReads: [] };
  const db = { 'gst/settings': o.settings === undefined ? { caEmail: CA } : o.settings, 'gst/mailSetup': o.prev || null };
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const deps = {
    log: (m) => st.logs.push(String(m)),
    mask: (v) => st.masked.push(v),
    dbToken: 'db', cfToken: o.cfToken === undefined ? 'cf' : o.cfToken, cfAccount: 'acct',
    now: () => 1790000000000,
    resolveMx: async (d) => { const mx = (o.mx || { 'ila.cafe': CF_MX })[d]; if (!mx) throw new Error('ENODATA'); return mx; },
    fetch: async (url, init) => {
      init = init || {};
      const m = /firebasedatabase\.app\/(.+)\.json$/.exec(url);
      if (m) {
        if (init.method === 'PUT') { st.dbWrites[m[1]] = JSON.parse(init.body); return json(200, null); }
        st.dbReads.push(m[1]);
        return json(200, db[m[1]] === undefined ? null : db[m[1]]);
      }
      st.cfCalls.push({ url, method: init.method || 'GET', body: init.body || null });
      if (/email\/routing\/addresses\?/.test(url)) return o.list ? o.list() : json(200, { success: true, result: [] });
      if (/email\/routing\/addresses$/.test(url) && init.method === 'POST')
        return o.add ? o.add() : json(200, { success: true, result: { email: CA, verified: null } });
      return json(404, { success: false });
    },
  };
  return { deps, st };
}
const leaks = (st) => st.logs.some(l => l.toLowerCase().indexOf(CA) >= 0) ||
                      JSON.stringify(st.dbWrites).toLowerCase().indexOf(CA) >= 0;

(async () => {
  // ------------------------------------------------------------- first run, CA saved
  {
    const { deps, st } = harness();
    const r = await run(deps);
    check('the sending domain is the one with Cloudflare’s MX records', r.report.domain === 'ila.cafe' && r.report.from === 'invoices@ila.cafe');
    check('and the Worker is to be told it, the first time', r.fromChanged === true);
    const post = st.cfCalls.find(c => c.method === 'POST');
    check('the CA’s address is registered with Email Routing when it is not there yet',
          !!post && JSON.parse(post.body).email === CA && r.report.ca === 'added');
    check('it is masked in the log before anything else happens', st.masked[0] === CA);
    check('and never printed, nor written back', !leaks(st), st.logs.join(' | '));
    check('what the owner’s card reads is written to gst/mailSetup', st.dbWrites['gst/mailSetup'] && st.dbWrites['gst/mailSetup'].ca === 'added');
  }
  // ------------------------------------------------------------- later runs
  {
    const { deps, st } = harness({ prev: { fromSet: 'invoices@ila.cafe' },
      list: () => ({ ok: true, status: 200, json: async () => ({ success: true, result: [{ email: 'CA.Person@Example.test', verified: null }] }) }) });
    const r = await run(deps);
    check('once registered it is waiting for the CA’s click, and is not registered twice',
          r.report.ca === 'pending' && !st.cfCalls.some(c => c.method === 'POST'));
    check('the Worker is not told the sender again', r.fromChanged === false);
    check('the sender already put is remembered', st.dbWrites['gst/mailSetup'].fromSet === 'invoices@ila.cafe');
  }
  {
    const { deps, st } = harness({ prev: { fromSet: 'invoices@ila.cafe' },
      list: () => ({ ok: true, status: 200, json: async () => ({ success: true, result: [{ email: CA, verified: '2026-11-27T05:00:00Z' }] }) }) });
    const r = await run(deps);
    check('and once the CA has clicked, it says so', r.report.ca === 'verified' && !st.cfCalls.some(c => c.method === 'POST'));
  }
  // ------------------------------------------------------------- nothing to do yet
  {
    const { deps, st } = harness({ settings: {} });
    const r = await run(deps);
    check('with no CA email saved, nothing is registered', r.report.ca === 'none' && !st.cfCalls.some(c => c.method === 'POST'));
  }
  // ------------------------------------------------------------- what it cannot do
  {
    const { deps, st } = harness({ list: () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }) }) });
    const r = await run(deps);
    check('a token without Email Routing permission is reported, with the permission it needs',
          r.report.routing === 'no-permission' && st.logs.some(l => /Email Routing Addresses/.test(l)));
  }
  {
    const { deps, st } = harness({ add: () => ({ ok: false, status: 400, json: async () => ({ success: false, errors: [{ code: 2032, message: 'Invalid address ' + CA }] }) }) });
    const r = await run(deps);
    check('a refusal is reported by its codes', r.report.ca === 'refused' && r.report.caError === '400 2032');
    check('and the message Cloudflare sent with it, which names the address, is not printed', !leaks(st), st.logs.join(' | '));
  }
  {
    const { deps } = harness({ mx: { 'cafeila.app': CF_MX } });
    const r = await run(deps);
    check('the other domain is used when Email Routing is on that one instead', r.report.from === 'invoices@cafeila.app');
  }
  {
    const { deps } = harness({ mx: { 'ila.cafe': [{ exchange: 'aspmx.l.google.com', priority: 1 }] } });
    const r = await run(deps);
    check('mail handled elsewhere is not mistaken for Email Routing', r.report.domain === null && r.fromChanged === false);
  }
  {
    const { deps } = harness({ cfToken: '' });
    const r = await run(deps);
    check('with no Cloudflare credential it says so rather than guessing', r.report.routing === 'no-credential');
  }
  note('the CA still has to click Cloudflare’s link: that is the one step Email Routing will not skip');
  done();
})();
