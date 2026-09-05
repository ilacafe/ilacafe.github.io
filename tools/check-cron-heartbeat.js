#!/usr/bin/env node
// Has each scheduled job in the Worker run recently enough?
//
// reportIfItThrows catches a cron that THROWS. Nothing catches one that stops
// FIRING, and there are several ways for that: `wrangler deploy` makes the cron
// list in wrangler.toml authoritative, so a schedule missing from that file is
// removed; a suspended, over-quota or badly-deployed Worker runs nothing at all.
//
// In every one of those, ops/cronFailure stays empty, no push is sent, and the
// Worker-health panel reports nothing wrong. The hourly monitor — which is what
// notices unpaid web orders and raises the per-bank alarm — has simply stopped,
// and it is indistinguishable from a quiet week.
//
// Nothing inside the Worker can raise an alarm about its own silence, so the
// reader has to be somewhere else. This is that reader. The Worker writes
// ops/cronHeartbeat/{job} at the end of every run that FINISHED; this asks how
// long ago that was and fails when the answer is too long.
//
// Usage:  FIREBASE_SERVICE_ACCOUNT='<key JSON>' node tools/check-cron-heartbeat.js
//
// Exits 0 when every job is inside its window, 1 otherwise. Read-only: it writes
// nothing and cannot deploy.
//
// The token minting is duplicated from verify-analytics.js for the reason that
// file gives — those scripts cannot be exercised without the credential, and
// refactoring them blind to save twenty lines is a bad trade.

const crypto = require('crypto');

const DB = process.env.DB_URL ||
  'https://ila-cafe-default-rtdb.asia-southeast1.firebasedatabase.app';
const SCOPES = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// How long a job may go between finishes before its silence is the finding.
// Deliberately generous — this is here to catch a cron that has STOPPED, not to
// complain about one that ran late. The monitor is hourly, so three hours is
// three consecutive misses. The refit is monthly, so 35 days is one miss plus
// the longest month.
//
// These mirror CRON_STALE_MS in analytics.html. Two readers of the same record
// disagreeing about what "overdue" means would be its own small bug, so if one
// moves, move both.
const WINDOW_MS = {
  monitor:       3 * 3600 * 1000,
  recalibration: 35 * 24 * 3600 * 1000,
};

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

function ago(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 90) return mins + ' minutes ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return hrs + ' hours ago';
  return Math.round(hrs / 24) + ' days ago';
}

(async () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.error('FIREBASE_SERVICE_ACCOUNT is not set'); process.exit(1); }
  let sa;
  try { sa = JSON.parse(raw); }
  catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT is not JSON'); process.exit(1); }

  const token = await accessToken(sa);
  const res = await fetch(DB + '/ops/cronHeartbeat.json', {
    headers: { Authorization: 'Bearer ' + token },
  });
  // A read that could not be made says nothing about the crons, and must not be
  // reported as though it did. This is the same trap tools/probe-rules.js was
  // caught in: every way of not reaching the database looks like an answer.
  if (!res.ok) {
    console.error('could not read ops/cronHeartbeat: ' + res.status + ' ' + res.statusText);
    console.error('nothing was checked — this is not a statement about the crons');
    process.exit(1);
  }
  const beats = (await res.json()) || {};

  const now = Date.now();
  const overdue = [], lines = [];
  let seen = 0;

  for (const job of Object.keys(WINDOW_MS)) {
    const at = Number(beats[job] && beats[job].at) || 0;
    if (!at) {
      // Never having run is not the same as having stopped. A job that has not
      // finished once since the heartbeat shipped has nothing to report yet, and
      // failing on it would mean the monthly refit looked broken for a month
      // after the deploy that added this.
      lines.push('  --   ' + job + ' has not reported a finish yet');
      continue;
    }
    seen++;
    const age = now - at;
    const late = age > WINDOW_MS[job];
    lines.push((late ? '  LATE ' : '  ok   ') + job + ' finished ' + ago(age) +
               ' (window ' + Math.round(WINDOW_MS[job] / 3600000) + 'h)');
    if (late) overdue.push(job + ', last finished ' + ago(age));
  }

  console.log('scheduled jobs in ' + DB.replace(/^https:\/\//, '') + ':');
  lines.forEach(l => console.log(l));

  if (overdue.length) {
    console.log('');
    for (const o of overdue) console.log('::error::a scheduled job has stopped finishing: ' + o);
    console.log('::error::Check the Triggers tab on the ila-push Worker — `wrangler deploy` makes');
    console.log('::error::the cron list in wrangler.toml authoritative, so a schedule missing from');
    console.log('::error::that file is removed. Also check the Worker is not suspended or over quota.');
    process.exit(1);
  }

  if (!seen) {
    console.log('');
    console.log('::warning::no job has reported a finish yet, so nothing could be checked.');
    console.log('::warning::Expected for the first hour after the heartbeat ships; if the monitor');
    console.log('::warning::is still silent after that, it is not running.');
  } else {
    console.log('');
    console.log('every scheduled job that has ever run is inside its window');
  }
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
