#!/usr/bin/env node
// Read the rules the database is actually enforcing, and compare them to the file.
//
// A deploy that reported success and changed nothing is the failure the whole
// deploy-rules workflow exists to rule out, and the rules are the only real
// security boundary in this project — so "it said OK" is not good enough.
//
// Usage:  FIREBASE_SERVICE_ACCOUNT='<the key JSON>' node tools/verify-rules.js
//         ... node tools/verify-rules.js --save <file>
//
// Exits 0 if they match, 1 with a diff if they do not. With --save it writes the
// live rules to <file> and compares nothing — that copy is what the deploy rolls
// back to if the checks after it fail, so a bad rules file cannot be left live.
//
// The token is minted here rather than with google-github-actions/auth, which
// reaches for the IAM Service Account Credentials API to *impersonate* the
// account — an API that is off by default and would have to be turned on for
// this one read. A service-account key can sign for itself: that is the
// jwt-bearer grant below, and it needs nothing but the OAuth token endpoint.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB = process.env.DB_URL ||
  'https://ila-cafe-default-rtdb.asia-southeast1.firebasedatabase.app';
const RULES_FILE = path.join(__dirname, '..', 'database.rules.json');
const SCOPES = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const signingInput =
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({
      iss: sa.client_email,
      scope: SCOPES,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 600,
    }));
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(signingInput), sa.private_key));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signingInput + '.' + sig,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // body.error/error_description are Google's, and carry no secret of ours.
    throw new Error('token endpoint said ' + res.status + ': ' +
                    (body.error_description || body.error || 'no access_token'));
  }
  return body.access_token;
}

// A rules file is JSON with comments — Firebase accepts them, and they are
// usually the most useful thing in it. The live copy comes back without them and
// with its own spacing, so compare the parsed structures, never the bytes.
function parseRules(text) {
  return JSON.parse(
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  );
}

(async () => {
  // Checked before the credential is touched, so a typo here says so rather than
  // surfacing as an unrelated crypto error from signing.
  const saveAt = process.argv.indexOf('--save');
  const saveTo = saveAt === -1 ? null : process.argv[saveAt + 1];
  if (saveAt !== -1 && !saveTo) {
    console.error('--save needs a file to write to');
    process.exit(1);
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error('FIREBASE_SERVICE_ACCOUNT is not set');
    process.exit(1);
  }
  let sa;
  try { sa = JSON.parse(raw); }
  catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT is not JSON — paste the whole key file'); process.exit(1); }
  if (!sa.client_email || !sa.private_key) {
    console.error('that JSON has no client_email/private_key — is it the service-account key?');
    process.exit(1);
  }

  const token = await accessToken(sa);
  const res = await fetch(DB + '/.settings/rules.json', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) {
    console.error('could not read the live rules: ' + res.status + ' ' + res.statusText);
    process.exit(1);
  }
  const liveText = await res.text();

  // --save: keep what is live right now, so there is something to go back to.
  if (saveTo) {
    // Parse before writing. A truncated response or a proxy's error page, saved as
    // "the rules to restore", turns the rollback into a second outage — so nothing
    // is written unless it reads as a rules file, and the deploy that follows this
    // step never runs without a backup because this exits non-zero.
    let parsed = null;
    try { parsed = parseRules(liveText); } catch (e) {
      console.error('the live rules did not parse, so there is nothing safe to roll back to');
      console.error('  ' + e.message);
      console.error('  first 120 bytes: ' + JSON.stringify(liveText.slice(0, 120)));
      process.exit(1);
    }
    if (!parsed || !parsed.rules) {
      console.error('what came back has no "rules" key — not saving it as a rollback target');
      process.exit(1);
    }
    fs.writeFileSync(saveTo, JSON.stringify(parsed, null, 2) + '\n');
    console.log('kept the rules that are live now (' + liveText.length + ' bytes) in case this deploy has to be undone');
    return;
  }

  const live = parseRules(liveText);
  const repo = parseRules(fs.readFileSync(RULES_FILE, 'utf8'));

  if (JSON.stringify(live) === JSON.stringify(repo)) {
    console.log('the live rules match database.rules.json');
    return;
  }

  console.log('::error::the live rules do NOT match database.rules.json');
  const a = JSON.stringify(repo, null, 2).split('\n');
  const b = JSON.stringify(live, null, 2).split('\n');
  console.log('--- database.rules.json');
  console.log('+++ live');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) console.log('-' + a[i]);
      if (b[i] !== undefined) console.log('+' + b[i]);
    }
  }
  process.exit(1);
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
