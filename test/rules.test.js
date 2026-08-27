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
const { ROOT, suite, APPS, derivePaths, readPage, stripComments } = require('./helpers');

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

// ---------------------------------------------------------------- public reads are the narrow ones
// Rules cascade downwards and cannot be revoked lower down: a `.read: true` on a
// parent grants read to everything beneath it, whatever the children say. So a
// public read has to sit on the exact node the public needs and nowhere above it.
//
// This is the whole list of what a stranger can read. Everything on it is here
// because index.html needs it before anyone signs in; nothing else belongs.
//
// eta is the branch that went wrong: the public read sat on `eta` itself, so it
// also published eta/recalMeta — the refit's own record, carrying how many orders
// the café completed in the last 75 days. Only model and live are needed.
{
  const PUBLIC_READS_ALLOWED = [
    'menu',          // the customer needs prices to order
    'settings',      // opening hours, whether ordering is on
    'eta/model',     // the wait-time model
    'eta/live',      // current load, for the wait estimate
    // A customer following their own order, by its id. The NODE is not public any
    // more: a query needs read on what it queries, and that read handed anyone the
    // café's whole order history in one request. The lookup moved to a per-table
    // index carrying trackIds and timestamps and nothing else.
    'orders/track/$trackId',
    'orders/tableIndex/$tableLabel',
  ];

  const publicReads = findOpenNodes(root, [], [])
    .filter(o => o.op === '.read')
    .map(o => o.where);

  const unexpected = publicReads.filter(w => !PUBLIC_READS_ALLOWED.includes(w));
  check('the world-readable list is exactly what the ordering page needs',
        unexpected.length === 0, unexpected.join(', '));
  unexpected.forEach(w => note('anyone on the internet can read: ' + w));
  note('a .read on a parent grants read to everything under it and cannot be');
  note('revoked lower down, so widening one of these opens whatever it contains');

  // The other half: the public reads must still cover what the customer page
  // needs, or the ordering page silently shows nothing and says nothing about why.
  const missing = PUBLIC_READS_ALLOWED.filter(w => !publicReads.includes(w));
  check('and every one of them is still actually public',
        missing.length === 0, missing.join(', ') + ' is no longer readable by a customer');
}

// ---------------------------------------------------------------- Firebase will accept it
// This file parses as JSON long after Firebase has stopped accepting it. A rules
// file using "//" keys as comments passed every check here and was refused at
// deploy time with `33:13: Expected '}'` — because a path segment cannot contain
// a slash, so "//" is not a comment, it is an illegal child name.
//
// The deploy refusing it is the right failure, but it happens at the moment you
// are trying to ship, which is the worst time to discover it.
{
  // Everything Firebase allows as a key: the rule keywords, a $wildcard, or a
  // child name. Child names may not contain . $ # [ ] / or control characters.
  const KEYWORDS = new Set(['.read', '.write', '.validate', '.indexOn', '.priority']);
  const ILLEGAL = /[.$#[\]/]/;

  const bad = [];
  (function walk(node, trail) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const where = trail.concat(key).join(' > ');
      if (KEYWORDS.has(key)) continue;
      if (key.startsWith('$')) {
        if (ILLEGAL.test(key.slice(1))) bad.push(where + '  (wildcard with an illegal character)');
      } else if (key.startsWith('.')) {
        bad.push(where + '  (unknown rule keyword)');
      } else if (ILLEGAL.test(key)) {
        bad.push(where + '  (a child name cannot contain . $ # [ ] or /)');
      }
      if (typeof node[key] === 'object') walk(node[key], trail.concat(key));
    }
  })(root, []);

  check('every key is one Firebase will accept', bad.length === 0, bad.join('; '));
  bad.forEach(b => note('rejected at deploy: ' + b));
  note('JSON-valid is not the same as rules-valid, and the difference only shows');
  note('up at deploy time — which is the worst moment to find out');
}

// ------------------------------------------------- what the deploy probe will ask
// tools/probe-rules.js runs after a rules deploy and asks the live database, with
// no credentials, what a stranger can read. Its public list is derived from this
// same file — which means a change here changes the requests it makes, and nothing
// exercised those requests until the deploy was already done.
//
// That is not hypothetical. Moving the customer's lookup onto a $wildcard gave the
// probe `orders/track/$trackId` to ask for; `$` is not a character Firebase accepts
// in a key, so it got 400 — neither allowed nor denied — and took a correct deploy
// down with it. The rules were right. The question was malformed.
{
  const probe = require('../tools/probe-rules.js');
  const open = probe.publicPaths(root);
  const denied = probe.MUST_BE_DENIED.concat(
    probe.ancestorsOf(open).filter(p => !probe.MUST_BE_DENIED.includes(p))
  );

  // A rule path is not a database path. Every segment the probe sends must be a key
  // Firebase will accept, or the answer carries no information either way.
  const ILLEGAL_KEY = /[.$#[\]]/;
  const malformed = open.concat(denied)
    .map(p => ({ rule: p, url: probe.toDbPath(p) }))
    .filter(({ url }) => url !== '' &&
            url.split('/').some(seg => seg === '' || ILLEGAL_KEY.test(seg)));

  check('every path it would request is one Firebase can answer',
        malformed.length === 0,
        malformed.map(m => m.rule + ' -> ' + m.url).join(', '));
  malformed.forEach(m => note(m.url + ' is not a legal path, so its status means nothing'));

  // A path cannot be both. If it ever is, the probe fails after the deploy with a
  // contradiction rather than a finding, and the rollback hides which half is wrong.
  const both = open.filter(p => denied.includes(p));
  check('nothing is on both its lists at once', both.length === 0, both.join(', '));

  // The point of the derived half: a public read below the top of a node is only
  // safe while the node above it stays shut. Public at the top hands out in one
  // request what the wildcard hands out one key at a time.
  const unguarded = open
    .filter(p => p.includes('/'))
    .map(p => p.slice(0, p.lastIndexOf('/')))
    .filter(parent => !denied.includes(parent) && !open.includes(parent));
  check('and the node above each public wildcard is checked too',
        unguarded.length === 0, unguarded.join(', '));
  note('a public read one level up is the same leak, served in a single request');
}

// ------------------------------------------------- nothing fell out of the map
// Everything above, and the whole emulator suite, is only as good as the map the
// paths come from. That map is built by scanning for db.ref('literal') and then
// looking at what follows for a read or a write verb — and a site whose verb it
// does not recognise is dropped, silently, straight out of every check downstream.
//
// That is not a hypothetical shape of bug in this repo. The emulator's coverage half
// looked each role up in a table of identities and skipped a miss, so `customer
// (anonymous)` matched nothing and eighteen questions about the one caller with no
// credentials were never asked, for as long as it had existed.
//
// So: every path a page names must survive into the map, as itself or as the parent
// of something. A site whose path another site already covers is fine — what is not
// fine is a path that no longer appears anywhere.
{
  const derived = [...used.keys()];
  const missing = [];

  for (const [file] of Object.entries(APPS)) {
    const src = readPage(file);
    for (const m of src.matchAll(/db\.ref\(\s*(['"`])([^'"`]*)\1/g)) {
      // Cut at a template hole and trim the separator: `orders/track/` + id is a
      // claim about orders/track, and the map records it as orders/track/$key.
      let head = m[2].split('${')[0].replace(/\/+$/, '');
      if (!head || head.startsWith('.info')) continue;      // .info is always readable
      if (derived.some(k => k === head || k.startsWith(head + '/'))) continue;
      missing.push(file + ' names ' + head + ', and nothing in the map does');
    }
  }

  check('every path a page names survives into the access map',
        missing.length === 0, [...new Set(missing)].join('; '));
  note('a path the scanner drops is a path no rules check ever asks about, and');
  note('nothing anywhere would say so — the map would simply be smaller');
}

note('this checks shape and coverage only — whether a condition is CORRECT for a');
note('given role needs the Firebase emulator against real auth tokens');

done();
