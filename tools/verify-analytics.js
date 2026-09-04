#!/usr/bin/env node
// What analytics will actually find when somebody opens it.
//
// verify-rules.js proves the rules being ENFORCED are the rules in git. That is a
// different question from whether the page works: the rules for orders/daily can be
// live and correct while the node itself is empty, or holds days of an older shape
// that cannot answer the item drill-down. Both of those have already happened.
//
// So this asks the database what is in it, read-only, and says whether each thing
// analytics depends on is there. It writes nothing and cannot deploy.
//
// Usage:  FIREBASE_SERVICE_ACCOUNT='<key JSON>' node tools/verify-analytics.js
//
// Exits 0 if everything analytics needs is present, 1 otherwise, with the reason.
//
// Every count below is a SHALLOW read — ?shallow=true returns keys and not values —
// because counting the café's order history by downloading it would be the exact
// 13MB read the rollups exist to avoid. The one deep read is a single day.
//
// The token minting is duplicated from verify-rules.js rather than shared. That file
// is on the critical path of the rules deploy and cannot be exercised without the
// credential, so refactoring it blind to save twenty lines is a bad trade.

const crypto = require('crypto');

const DB = process.env.DB_URL ||
  'https://ila-cafe-default-rtdb.asia-southeast1.firebasedatabase.app';
const SCOPES = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const input =
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({
      iss: sa.client_email, scope: SCOPES,
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 600,
    }));
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(input), sa.private_key));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: input + '.' + sig,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error('token endpoint said ' + res.status + ': ' +
                    (body.error_description || body.error || 'no access_token'));
  }
  return body.access_token;
}

(async () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.error('FIREBASE_SERVICE_ACCOUNT is not set'); process.exit(1); }
  let sa;
  try { sa = JSON.parse(raw); }
  catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT is not JSON'); process.exit(1); }

  const token = await accessToken(sa);
  const get = async (path, opts) => {
    const url = DB + '/' + path + '.json' + (opts || '');
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error(path + ': ' + res.status + ' ' + res.statusText);
    return res.json();
  };
  const countOf = (v) => (v && typeof v === 'object') ? Object.keys(v).length : 0;

  const problems = [], lines = [];
  const say = (ok, text) => { lines.push((ok ? '  ok   ' : '  MISS ') + text); if (!ok) problems.push(text); };

  // ---- the rollups the totals and the drill-down are served from
  const daily = await get('orders/daily', '?shallow=true');
  const days = Object.keys(daily || {}).sort();
  say(days.length > 0, 'orders/daily holds ' + days.length + ' day(s)');

  if (days.length) {
    // One deep read, of the newest day, to see the SHAPE rather than trust the count.
    const newest = days[days.length - 1];
    const d = await get('orders/daily/' + newest);
    const items = Object.keys((d && d.item) || {});
    say(typeof (d && d.rev) === 'number', newest + ' carries revenue (' + (d && d.rev) + ')');
    say(items.length > 0, newest + ' carries ' + items.length + ' item(s)');
    if (items.length) {
      // The field the item drill-down needs. Rollups written before it existed are
      // incomplete rather than wrong, and the page rebuilds them — but until an
      // admin has opened analytics since, they are still the older shape.
      const withO = items.filter(k => typeof d.item[k].o === 'number').length;
      say(withO === items.length,
          newest + ': ' + withO + '/' + items.length +
          ' items carry the per-item order count the drill-down needs');
      if (withO !== items.length) {
        lines.push('       (an admin opening analytics rebuilds these — it is not data loss)');
      }
    }
  }

  // ---- the cash-up index, and whether it covers the archive it indexes
  const summary = await get('pos/eodSummary', '?shallow=true');
  const archive = await get('pos/eodArchive', '?shallow=true');
  const nS = countOf(summary), nA = countOf(archive);
  say(nS > 0, 'pos/eodSummary holds ' + nS + ' closing(s)');
  say(nS >= Math.min(nA, 120),
      'which covers the ' + nA + ' closing(s) in pos/eodArchive');
  const mark = await get('pos/eodSummaryBackfill');
  say(!!mark, 'pos/eodSummaryBackfill marks the rebuild as done' +
              (mark && mark.days != null ? ' (' + mark.days + ' days)' : ''));

  console.log('what analytics will find in ' + DB.replace(/^https:\/\//, '') + ':');
  lines.forEach(l => console.log(l));

  if (problems.length) {
    console.log('');
    console.log('::warning::' + problems.length + ' thing(s) analytics depends on are not there yet.');
    console.log('::warning::If the rules were only just deployed, an admin has to OPEN analytics');
    console.log('::warning::once: the page is what builds the rollups and the cash-up index.');
    process.exit(1);
  }
  console.log('');
  console.log('everything analytics reads is present and the right shape');
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
