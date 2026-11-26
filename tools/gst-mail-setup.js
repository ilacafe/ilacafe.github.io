#!/usr/bin/env node
// Gets the monthly GST email to the accountant ready to go, with nobody at the
// Cloudflare dashboard. Run by .github/workflows/gst-mail-setup.yml.
//
// The Worker sends through Cloudflare Email Routing, which will only deliver to an
// address that is a verified destination on the account, from an address on the
// domain Email Routing runs on. Both of those used to be steps for a person:
//
//   - the sending domain is whichever of the café's domains has Email Routing's MX
//     records. That is public DNS, so this looks it up, and the workflow sets the
//     Worker's GST_MAIL_FROM to invoices@ that domain.
//   - the CA's address is typed once in Admin → GST Invoices, and lives only in
//     gst/settings, which only the owner and the robot can read. This reads it with
//     the service account and registers it as a destination, which is what makes
//     Cloudflare email the CA a link to confirm it. The one thing left to a person is
//     that click, and it is the CA's: Cloudflare will not deliver otherwise.
//
// THE REPOSITORY IS PUBLIC, and so are its Actions logs. The CA's address is masked
// the moment it is read, never printed, never put in an output, and never echoed
// back from Cloudflare (only status and error codes are). What this writes back is
// gst/mailSetup — states, not the address — and the owner's card reads it.

const crypto = require('crypto');

const DB = process.env.DB_URL || 'https://ila-cafe-default-rtdb.asia-southeast1.firebasedatabase.app';
const CF = 'https://api.cloudflare.com/client/v4';
// The café's domains, in the order to try. Email Routing is on whichever one carries
// Cloudflare's MX records.
const CANDIDATES = ['ila.cafe', 'cafeila.app'];
const SENDER = 'invoices';
const CF_MX = /(^|\.)mx\.cloudflare\.net\.?$/i;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
async function accessToken(sa, fetchImpl) {
  const now = Math.floor(Date.now() / 1000);
  const input = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 600,
  }));
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(input), sa.private_key));
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + sig }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error('token endpoint said ' + res.status);
  return body.access_token;
}

// The whole job, with everything it talks to passed in, so the test can run it.
//   deps: { fetch, resolveMx, log, mask, dbToken, cfToken, cfAccount, now }
async function run(deps) {
  const log = deps.log;
  const db = async (path, init) => {
    const res = await deps.fetch(DB + '/' + path + '.json', Object.assign({}, init || {},
      { headers: Object.assign({ Authorization: 'Bearer ' + deps.dbToken, 'Content-Type': 'application/json' }, (init && init.headers) || {}) }));
    if (!res.ok) throw new Error(path + ': the database answered ' + res.status);
    return res.json().catch(() => null);
  };
  const cf = async (path, init) => {
    const res = await deps.fetch(CF + path, Object.assign({}, init || {},
      { headers: { Authorization: 'Bearer ' + deps.cfToken, 'Content-Type': 'application/json' } }));
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok && body && body.success !== false, body: body || {} };
  };
  const codes = (r) => ((r.body && r.body.errors) || []).map(e => e && e.code).filter(Boolean).join(',') || '-';

  const settings = (await db('gst/settings')) || {};
  const ca = String(settings.caEmail || '').trim().toLowerCase();
  if (ca) deps.mask(ca);
  const prev = (await db('gst/mailSetup')) || {};

  // ---- which domain receives the café's email
  let domain = null;
  for (const d of CANDIDATES) {
    let mx = [];
    try { mx = await deps.resolveMx(d); } catch (e) { mx = []; }
    if (mx.some(r => CF_MX.test(String(r.exchange || '')))) { domain = d; break; }
  }
  const from = domain ? SENDER + '@' + domain : null;
  log(domain ? 'Email Routing is on ' + domain + ', so the GST mail is sent from ' + from
             : 'neither ' + CANDIDATES.join(' nor ') + ' has Cloudflare Email Routing MX records — no sending domain');

  // ---- the CA's address, as an Email Routing destination
  const report = { at: deps.now(), domain: domain, from: from, routing: 'unknown', ca: ca ? 'unknown' : 'none' };
  // The repository need not name its Cloudflare account — wrangler finds it from the
  // token, and so does this: a token that reaches exactly one account means that one.
  if (deps.cfToken && !deps.cfAccount) {
    const accts = await cf('/accounts?per_page=5');
    const list = (accts.ok && Array.isArray(accts.body.result)) ? accts.body.result : [];
    if (list.length === 1 && list[0] && list[0].id) deps.cfAccount = String(list[0].id);
    else log('could not tell which Cloudflare account to use (' + accts.status + ', ' + list.length + ' account(s)) — set CLOUDFLARE_ACCOUNT_ID');
  }
  if (!deps.cfToken || !deps.cfAccount) {
    report.routing = 'no-credential';
    log('CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is not set — destinations not checked');
  } else {
    const list = await cf('/accounts/' + encodeURIComponent(deps.cfAccount) + '/email/routing/addresses?per_page=50');
    if (list.ok) {
      report.routing = 'ok';
      if (!ca) {
        log('no CA email is saved in Admin → GST Invoices yet — nothing to register');
      } else {
        const hit = (list.body.result || []).find(a => String((a && a.email) || '').toLowerCase() === ca);
        if (hit && hit.verified) { report.ca = 'verified'; log('the CA’s address is a verified destination'); }
        else if (hit) { report.ca = 'pending'; log('the CA’s address is registered and waiting for the CA to click Cloudflare’s link'); }
        else {
          const add = await cf('/accounts/' + encodeURIComponent(deps.cfAccount) + '/email/routing/addresses',
                               { method: 'POST', body: JSON.stringify({ email: ca }) });
          if (add.ok) { report.ca = 'added'; log('registered the CA’s address; Cloudflare has emailed them a link to confirm it'); }
          else { report.ca = 'refused'; report.caError = add.status + ' ' + codes(add); log('::warning::Cloudflare refused to register the CA’s address (' + report.caError + ')'); }
        }
      }
    } else if (list.status === 401 || list.status === 403) {
      report.routing = 'no-permission';
      log('::warning::the Cloudflare token cannot read Email Routing destinations (' + list.status + ' ' + codes(list) + '). ' +
          'Give CLOUDFLARE_API_TOKEN the permission Account → Email Routing Addresses → Edit.');
    } else {
      report.routing = 'error';
      report.routingError = list.status + ' ' + codes(list);
      log('::warning::Cloudflare answered ' + report.routingError + ' for the destination list');
    }
  }
  if (prev.fromSet) report.fromSet = prev.fromSet;
  await db('gst/mailSetup', { method: 'PUT', body: JSON.stringify(report) });
  return { report: report, fromChanged: !!from && prev.fromSet !== from };
}

// After the workflow has put GST_MAIL_FROM on the Worker, the next run need not.
async function markFrom(deps, from) {
  const res = await deps.fetch(DB + '/gst/mailSetup/fromSet.json', {
    method: 'PUT', headers: { Authorization: 'Bearer ' + deps.dbToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(from),
  });
  if (!res.ok) throw new Error('could not record the sender: ' + res.status);
}

module.exports = { run, markFrom, accessToken, CANDIDATES, CF_MX };

if (require.main === module) {
  (async () => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) { console.error('FIREBASE_SERVICE_ACCOUNT is not set'); process.exit(1); }
    const sa = JSON.parse(raw);
    const deps = {
      fetch: globalThis.fetch,
      resolveMx: (d) => require('dns').promises.resolveMx(d),
      log: (m) => console.log(m),
      mask: (v) => console.log('::add-mask::' + v),
      dbToken: await accessToken(sa, globalThis.fetch),
      cfToken: process.env.CLOUDFLARE_API_TOKEN || '',
      cfAccount: process.env.CLOUDFLARE_ACCOUNT_ID || '',
      now: () => Date.now(),
    };
    const markArg = process.argv.indexOf('--mark-from');
    if (markArg > 0) { await markFrom(deps, process.argv[markArg + 1]); console.log('recorded the sender the Worker now uses'); return; }
    const r = await run(deps);
    const out = process.env.GITHUB_OUTPUT;
    if (out) require('fs').appendFileSync(out, 'from=' + (r.report.from || '') + '\nfrom_changed=' + (r.fromChanged ? 'true' : 'false') + '\n');
  })().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
}
