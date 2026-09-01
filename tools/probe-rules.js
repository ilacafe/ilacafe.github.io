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
//
// A REFUSAL IS ONLY EVIDENCE IF IT CAME FROM THE DATABASE
//
// Most of this reads a refusal as a pass, and that is sound exactly as long as the
// refusals are Firebase's. Every way of not reaching Firebase at all also produces
// refusals — a proxy that denies the host, a network policy, a DNS answer that goes
// nowhere, a corporate gateway. Run somewhere without a route to the database, the
// twenty-odd paths that must be denied are all "denied", and the report is a clean
// bill of health for a database this process never spoke to.
//
// That is not hypothetical either: run inside a sandbox whose egress proxy answers
// 403 to CONNECT, every single path came back 403, and the whole "what a stranger
// cannot" section printed OK. The half that matters most is the half that fails
// safe-looking.
//
// So the public paths are the POSITIVE CONTROL and they are checked first. If not
// one of them answers, this is not a test that failed — it is a test that never
// ran, and it says so and stops rather than reporting on refusals it cannot
// attribute.

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
  'orders/track',        // one order by its id, yes. every order the café has taken, no.
  'orders/tableIndex',   // one table's trackIds, yes. every table's in one request, no.
];

// A key that cannot exist. A public read declared on a $wildcard has to be asked
// about SOME child, and asking about a real one would mean pulling a real customer
// order out of the live database to prove a rule permits it. A miss answers 200
// with null, which settles the permission question exactly as well as a hit.
const PROBE_KEY = 'probe-no-such-key';

// A rule path is not a database path. `orders/track/$trackId` is where the rule
// lives; `$` is not a character Firebase accepts in a key, so asking for it
// literally gets 400 — neither allowed nor denied. That is how this failed the
// first time it met a wildcard, and it took a good deploy down with it.
function toDbPath(rulePath) {
  return rulePath.split('/').map(s => (s.startsWith('$') ? PROBE_KEY : s)).join('/');
}

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

// Where a public read sits below the top of a node, everything above it must stay
// shut. That is the same leak rebuilt one level up: `orders/tableIndex/{table}`
// hands out one table's trackIds; `orders/tableIndex` would hand out every one of
// them in a single request. Derived rather than listed, so a public path added
// later gets the same scrutiny without anyone remembering to ask for it.
function ancestorsOf(paths) {
  const out = [];
  for (const p of paths) {
    const segs = p.split('/');
    for (let i = segs.length - 1; i > 0; i--) {
      const parent = segs.slice(0, i).join('/');
      if (!paths.includes(parent) && !out.includes(parent)) out.push(parent);
    }
  }
  return out;
}

function readRules() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8');
  return JSON.parse(
    raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ).rules;
}

async function status(p) {
  // shallow=true keeps the response to a list of keys rather than the node, and
  // the body is cancelled either way — only the status matters here.
  const url = DB + '/' + p + '.json?shallow=true';
  const res = await fetch(url, { redirect: 'follow' });
  try { await res.body?.cancel(); } catch (e) {}
  return res.status;
}

// How a path is written in the report: the rule path, and what was actually asked
// for when substituting the wildcard made them differ.
function label(rulePath) {
  const dbPath = toDbPath(rulePath);
  if (!rulePath) return '(root)';
  return dbPath === rulePath ? rulePath : rulePath + '  (asked for ' + dbPath + ')';
}

async function main() {
  const open = publicPaths(readRules());
  if (!open.length) {
    console.log('::error::no public read found in database.rules.json — the ordering');
    console.log('::error::page needs several, so this is a broken rules file, not a tight one');
    process.exit(1);
  }

  const denied = MUST_BE_DENIED.concat(
    ancestorsOf(open).filter(p => !MUST_BE_DENIED.includes(p))
  );

  const both = open.filter(p => denied.includes(p));
  if (both.length) {
    console.log('::error::' + both.join(', ') + ' is both declared public in the rules');
    console.log('::error::and listed here as something a stranger must not read. One of the two is wrong.');
    process.exit(1);
  }

  const problems = [];

  console.log('what a stranger can read:');
  let reached = 0;
  for (const p of open) {
    const code = await status(toDbPath(p));
    const ok = code === 200;
    if (ok) reached++;
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + String(code) + '  ' + label(p));
    if (!ok) problems.push(p + ' should be public but answered ' + code);
  }

  // THE POSITIVE CONTROL, BEFORE ANY REFUSAL IS READ AS A PASS
  //
  // One public path answering 200 is proof that this process is talking to the
  // database and that the database is answering unauthenticated reads. Without
  // that, a refusal below could be Firebase's rules or it could be a proxy, a
  // network policy or an outage, and there is no way to tell them apart from a
  // status code — so nothing below is evidence of anything.
  //
  // Some public paths failing while others answer is a different thing entirely:
  // that is a real finding about the rules, and it goes through `problems` with
  // the rest. This only stops when NONE of them answered.
  if (reached === 0) {
    console.log('');
    console.log('::error::not one public path answered — this process is not reaching the database.');
    console.log('::error::' + DB);
    console.log('::error::Every path a stranger must not read would also be refused by whatever is');
    console.log('::error::in the way, so this run cannot tell a locked-down database from an');
    console.log('::error::unreachable one. Nothing about the rules has been checked.');
    console.log('::error::The deployed rules are NOT verified by this run.');
    process.exit(1);
  }

  console.log('\nwhat a stranger cannot:');
  for (const p of denied) {
    const code = await status(toDbPath(p));
    // 401 is the denial. A 200 is the failure this exists to catch; anything else
    // is inconclusive and is reported rather than passed over.
    const ok = code === 401 || code === 403;
    console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + String(code) + '  ' + label(p));
    if (code === 200) problems.push((p || 'the root') + ' IS READABLE BY ANYONE');
    else if (!ok) problems.push((p || 'the root') + ' answered ' + code + ', neither allowed nor denied');
  }

  if (problems.length) {
    console.log('');
    for (const m of problems) console.log('::error::' + m);
    process.exit(1);
  }
  console.log('\nthe deployed rules permit exactly the public surface and nothing else.');
}

// Required by the offline suite, which checks the paths this would ask for without
// asking for them. Only the command line makes requests.
module.exports = { MUST_BE_DENIED, PROBE_KEY, toDbPath, publicPaths, ancestorsOf, readRules };

if (require.main === module) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
