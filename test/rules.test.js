// The Realtime Database rules are the only real enforcement boundary in this
// project. Every app runs entirely in the customer's or the staff member's
// browser, so every check in the page source is advice: the rules are what
// actually stops a write.
//
// They have never been in git. Until `database.rules.json` is exported from the
// Firebase console (see docs/database-access.md) this suite can only report
// that, and it says so rather than passing silently on nothing.
//
// Once the file is there, this checks three things that do not need a running
// database:
//   1. it parses, and has a rules root
//   2. nothing is world-readable or world-writable
//   3. every path the apps actually use has SOME rule that could permit it —
//      an unruled path is denied by default, which means a broken app
//
// It cannot tell you whether a rule's condition is correct for a given role.
// That needs the Firebase emulator against real auth tokens.

const fs = require('fs');
const path = require('path');
const { ROOT, suite, APPS, derivePaths, stripComments } = require('./helpers');

const RULES_FILE = path.join(ROOT, 'database.rules.json');

// ---------------------------------------------------------------- rules walking
// Follow a path through the rules tree. A $wildcard segment matches anything.
// Returns the deepest node reached and whether any node along the way declared
// the operation — RTDB rules cascade, so an ancestor's grant covers descendants.
// A rule GRANTS if it is anything other than a flat deny. `false` at the root is
// the normal locked-down default and must not be mistaken for coverage — that was
// the bug that let a missing branch look ruled.
function grants(value) {
  return value !== undefined && value !== false && value !== 'false';
}

function govern(rules, segments, op) {
  let node = rules, granted = grants(rules && rules['.' + op]);
  for (const seg of segments) {
    if (!node || typeof node !== 'object') break;
    let next = node[seg];
    if (next === undefined) {
      const wildcard = Object.keys(node).find(k => k.startsWith('$'));
      if (wildcard) next = node[wildcard];
    }
    if (next === undefined) break;
    node = next;
    if (node && typeof node === 'object' && grants(node['.' + op])) granted = true;
  }
  return granted;
}

// Nodes that must NEVER be readable without authentication: staff holds PIN
// hashes, users holds roles, and the rest hold takings, ledgers and customer
// records. A public read on any of these is a leak, full stop.
//
// Everything else public-readable is reported rather than failed. The ordering
// page legitimately needs several nodes before anyone signs in — the menu, store
// settings, the ETA model, and live kitchen load for the wait estimate — and
// which of those is acceptable is a product judgement, not something this file
// can settle. The personal-data check below is the one that catches a public
// node quietly acquiring a phone number.
const NEVER_PUBLIC = [
  'staff', 'users', 'pos', 'payments', 'security', 'customers',
  'inventory', 'upiReview', 'upiRouting', 'pushSubscriptions', 'reconciliation',
];

function findOpenNodes(node, trail, out) {
  if (!node || typeof node !== 'object') return out;
  for (const key of Object.keys(node)) {
    if (key === '.read' || key === '.write') {
      if (node[key] === true || node[key] === 'true') {
        const where = trail.join('/') || '(root)';
        const forbidden = NEVER_PUBLIC.includes(trail[0]) || trail.length === 0;
        out.push({ where, op: key, forbidden });
      }
    } else if (typeof node[key] === 'object') {
      findOpenNodes(node[key], trail.concat(key), out);
    }
  }
  return out;
}

// ---------------------------------------------------------------- run
const { check, note, done } = suite('Database rules');

const used = derivePaths();
note(used.size + ' distinct paths used across the ' + Object.keys(APPS).length + ' apps');

if (!fs.existsSync(RULES_FILE)) {
  note('\x1b[33mdatabase.rules.json is not in the repo yet.\x1b[0m');
  note('The live rules are the only thing standing between a stranger and the till,');
  note('and nobody can review or diff what is not checked in. Export them with:');
  note('');
  note('    curl "https://ila-cafe-default-rtdb.asia-southeast1.firebasedatabase.app/.settings/rules.json\\');
  note('          ?access_token=$(gcloud auth print-access-token)" > database.rules.json');
  note('');
  note('or copy them out of the console (Realtime Database → Rules), then commit.');
  note('See docs/database-access.md. This suite starts checking them once they land.');
  done();
  return;
}

let rules = null;
const raw = fs.readFileSync(RULES_FILE, 'utf8');
try {
  rules = JSON.parse(stripComments(raw));
  check('database.rules.json parses (comments allowed)', true);
} catch (e) {
  check('database.rules.json parses (comments allowed)', false, e.message);
  done();
  return;
}

check('it has a "rules" root', !!(rules && rules.rules), Object.keys(rules || {}).join(', '));
const root = (rules && rules.rules) || {};

check('the database is not world-readable at the root', root['.read'] !== true && root['.read'] !== 'true',
      JSON.stringify(root['.read']));
check('the database is not world-writable at the root', root['.write'] !== true && root['.write'] !== 'true',
      JSON.stringify(root['.write']));

const open = findOpenNodes(root, [], []);
const writable   = open.filter(o => o.op === '.write');
const leaked     = open.filter(o => o.op === '.read' && o.forbidden);
const publicRead = open.filter(o => o.op === '.read' && !o.forbidden);

check('nothing is writable without authentication', writable.length === 0,
      writable.map(o => o.where).join(', '));
check('nothing on the never-public list is readable without authentication', leaked.length === 0,
      leaked.map(o => o.where).join(', '));
writable.forEach(o => note('world-writable: ' + o.where));
leaked.forEach(o => note('world-readable and must not be: ' + o.where));
if (publicRead.length) note('publicly readable (the ordering page needs these): ' +
                            publicRead.map(o => o.where).join(', '));

// ---------------------------------------------------------------- personal data
// A publicly readable node is fine right up until something starts writing a
// phone number into it. Rules cannot say "readable except for this field", so the
// fix is always to stop writing the field rather than to move a rule — which is
// why this is checked against the source, not against the rules.
const PERSONAL = /\b(phone|email|address|mobile|contact)\s*:/;
const exposed = [];
for (const [p, ops] of used) {
  if (!ops.writes || !ops.writes.length) continue;
  // readable by someone who never signed in?
  let node = root, pub = root['.read'] === true;
  for (const seg of p.split('/')) {
    if (!node || typeof node !== 'object') break;
    let next = node[seg];
    if (next === undefined) {
      const wildcard = Object.keys(node).find(k => k.startsWith('$'));
      if (wildcard) next = node[wildcard];
    }
    if (next === undefined) break;
    node = next;
    if (node && typeof node === 'object' && node['.read'] === true) pub = true;
  }
  if (!pub) continue;
  for (const w of ops.writes) {
    const hit = w.snippet.match(PERSONAL);
    if (hit) exposed.push(p + '  ← ' + w.file + ' writes ' + hit[1]);
  }
}
check('no personal data is written into a publicly readable node', exposed.length === 0,
      exposed.length + ' found');
exposed.forEach(e => note('anyone can read this: ' + e));

// Every path an app uses needs a rule that could permit it. Unruled means denied,
// which shows up as a feature that silently does nothing.
const unruled = [];
for (const [p, ops] of used) {
  const segments = p.split('/');
  for (const op of ['read', 'write']) {
    if (!ops[op].size) continue;
    if (!govern(root, segments, op)) unruled.push(op + ' ' + p + '  (' + [...ops[op]].join(', ') + ')');
  }
}
check('every path the apps use has a rule that could permit it', unruled.length === 0,
      unruled.length + ' unruled');
unruled.forEach(u => note('no rule governs: ' + u));

note('this checks shape and coverage only — whether a condition is CORRECT for a');
note('given role needs the Firebase emulator against real auth tokens');

done();
