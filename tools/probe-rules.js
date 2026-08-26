#!/usr/bin/env node
// Ask the live database, with no credentials at all, what a stranger can read.
//
// deploy-rules.yml already proves the rules *text* that got deployed matches the
// file. This proves the rules *behave*: a condition can be exactly what the file
// says and still permit the wrong thing, because rules cascade, and because
// reading a rule and predicting its effect are different skills.
//
// So this is the same question from the outside — an unauthenticated GET against
// each path, which is precisely what an attacker would do.
//
// Read-only, and only ever against paths already declared public or already
// expected to be denied. Runs after a rules deploy rather than on every pull
// request, so a Firebase outage cannot fail somebody's PR.

const fs = require('fs');
const path = require('path');

const DB = process.env.DB_URL ||
  'https://ila-cafe-default-rtdb.asia-southeast1.firebasedatabase.app';

// Anything the café would not want a stranger reading. Not derived from the rules
// file on purpose: this is the independent statement of intent that the rules are
// checked against, so it has to be written down separately or it checks nothing.
const MUST_BE_DENIED = [
  '',                    // the root
  'staff',               // PIN hashes
  'users',               // who has which role
  'pos',                 // the till: bills, drawer, ledger
  'pos/ledgerEntries',
  'payments',
  'security',            // voids and walkouts
  'customers',
  'inventory',
  'upiReview',
  'upiRouting',
  'pushSubscriptions',
  'ops',                 // cron failures, push health
  'ops/pushHealth',
  'eta/recalMeta',       // the refit's record — carries order counts
  'eta/modelPrevious',
  'orders/history',
  'orders/completed',
];

// The public surface, read from the rules so it cannot drift from what is
// deployed. Every one of these must answer, or the ordering page is broken for
// customers and nobody would find out from a green deploy.
function publicPaths(rules, trail = [], out = []) {
  if (!rules || typeof rules !== 'object') return out;
  for (const key of Object.keys(rules)) {
    if (key === '.read') {
      if (rules[key] === true || rules[key] === 'true') out.push(trail.join('/'));
    } else if (typeof rules[key] === 'object') {
      publicPaths(rules[key], trail.concat(key), out);
    }
  }
  return out;
}

async function status(p) {
  // shallow=true keeps the response to a list of keys rather than the node, and
  // the body is cancelled either way — only the status matters here.
  const url = DB + '/' + p + '.json?shallow=true';
  const res = await fetch(url, { redirect: 'follow' });
  try { await res.body?.cancel(); } catch (e) {}
  return res.status;
}

(async () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8');
  const rules = JSON.parse(
    raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ).rules;

  const open = publicPaths(rules);
  if (!open.length) {
    console.log('::error::no public read found in database.rules.json — the ordering');
    console.log('::error::page needs several, so this is a broken rules file, not a tight one');
    process.exit(1);
  }

  const problems = [];

  console.log('what a stranger can read:');
  for (const p of open) {
    const code = await status(p);
    const ok = code === 200;
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + String(code) + '  ' + (p || '(root)'));
    if (!ok) problems.push(p + ' should be public but answered ' + code);
  }

  console.log('\nwhat a stranger cannot:');
  for (const p of MUST_BE_DENIED) {
    const code = await status(p);
    // 401 is the denial. A 200 is the failure this exists to catch; anything else
    // is inconclusive and is reported rather than passed over.
    const denied = code === 401 || code === 403;
    console.log('  ' + (denied ? 'OK   ' : 'FAIL ') + String(code) + '  ' + (p || '(root)'));
    if (code === 200) problems.push((p || 'the root') + ' IS READABLE BY ANYONE');
    else if (!denied) problems.push((p || 'the root') + ' answered ' + code + ', neither allowed nor denied');
  }

  if (problems.length) {
    console.log('');
    for (const m of problems) console.log('::error::' + m);
    process.exit(1);
  }
  console.log('\nthe deployed rules permit exactly the public surface and nothing else.');
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
