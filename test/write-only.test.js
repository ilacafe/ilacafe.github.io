// Which paths does something write that nothing reads?
//
// Asked once by hand, this question found two features that had been recording
// faithfully for as long as they had existed and were readable from nowhere:
//
//   inventory/logs   every prep batch and delivery — who, what, how much, and
//                    what came off the shelf to make it
//   security/unpaid  every bill written off at cash-up — the table, the items
//                    on it, what had been paid, and who authorised the rest
//
// Both were found the same way and neither was a subtle bug. The write worked;
// nobody had closed the loop. This asks the question on every run, so the next
// one is caught when it is written rather than years later.
//
// A path counts as read if any app reads it, an ancestor of it, or a descendant
// of it. Writing orders/active/chef/$id and reading orders/active/chef is one
// feature, not an orphan.

const fs = require('fs');
const path = require('path');
const { ROOT, derivePaths, unresolvedWrites, suite } = require('./helpers');

// The Worker is not one of the apps, so derivePaths does not see it — and it is
// the component most likely to have a write nobody reads, because none of it is
// on a screen. eta/modelPrevious was found by hand for exactly that reason.
function workerPaths() {
  const src = fs.readFileSync(path.join(ROOT, 'worker', 'worker.js'), 'utf8');
  const out = new Map();
  const touch = (p, kind) => {
    const key = p.replace(/^\//, '');
    if (!key) return;                       // the root PATCH, handled below
    const rec = out.get(key) || { read: false, write: false };
    rec[kind] = true;
    out.set(key, rec);
  };
  for (const m of src.matchAll(/DB_URL \+ '([^']+)'/g)) {
    let p = m[1].replace(/\.json.*$/, '');
    p = p.endsWith('/') && p !== '/' ? p + '$key' : p;
    const after = src.slice(m.index, m.index + 260);
    touch(p, /method\s*:\s*'(PUT|PATCH|POST|DELETE)'/.test(after) ? 'write' : 'read');
  }
  // monLoad only ever reads, and the root PATCH writes monitor/* in one call.
  for (const m of src.matchAll(/monLoad\([^,]+,\s*'([^']+)'\)/g)) touch(m[1], 'read');
  touch('/monitor', 'write');
  return out;
}

const { check, note, done } = suite('Write-only paths — recorded and unreadable');

// Written on purpose with nothing reading it back. Empty, and adding to it should
// take an argument: a record nobody can see is usually a feature half-built, not
// a decision. Each entry needs a reason.
const DELIBERATELY_WRITE_ONLY = {
  // 'some/path': 'why nothing needs to read this',
};

const used = derivePaths();
const worker = workerPaths();

// One view of the whole system: the pages and the Worker together. A path the
// Worker writes and a page reads is a working feature, and so is the reverse —
// splitting them would report both halves as orphans.
const all = new Map();
for (const [p, v] of used) all.set(p, { read: v.read.size > 0, write: v.write.size > 0, who: [...v.write] });
for (const [p, v] of worker) {
  const rec = all.get(p) || { read: false, write: false, who: [] };
  if (v.read) rec.read = true;
  if (v.write) { rec.write = true; rec.who = rec.who.concat('the Worker'); }
  all.set(p, rec);
}
const paths = [...all.keys()];

// $key stands for a segment the deriver could not resolve — an id, or a variable
// like KDS_STATION. It matches any single segment, so writing
// orders/active/$key is covered by reading orders/active/chef.
function related(a, b) {
  const x = a.split('/'), y = b.split('/');
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] === '$key' || y[i] === '$key') continue;
    if (x[i] !== y[i]) return false;
  }
  return true;   // one is the other, or an ancestor of it
}

const readable = paths.filter(p => all.get(p).read);
const written = paths.filter(p => all.get(p).write);

const orphans = [];
for (const p of paths) {
  const rec = all.get(p);
  if (!rec.write) continue;
  if (p in DELIBERATELY_WRITE_ONLY) continue;
  if (readable.some(r => related(p, r))) continue;
  orphans.push(p + ' (written by ' + rec.who.sort().join(', ') + ')');
}

check('every path an app writes is read back somewhere',
      orphans.length === 0,
      orphans.join('; '));
orphans.forEach(o => note('nothing can see: ' + o));

note(paths.length + ' paths across the pages and the Worker, ' +
     readable.length + ' read by something, ' + written.length + ' written by something');

// ---------------------------------------------------------------- and the reverse
// A path something reads and nothing writes is a screen that will always be
// empty. Harder to notice than a write-only path, because an empty list looks
// like a quiet day.
{
  const NOTHING_WRITES_THESE = {
    // Written by a person, in the Firebase console or by hand.
    'staff': 'PIN hashes, set up by the owner rather than by any page',
  };

  const unfed = [];
  for (const p of paths) {
    const rec = all.get(p);
    if (!rec.read) continue;
    if (p in NOTHING_WRITES_THESE) continue;
    if (written.some(w => related(p, w))) continue;
    unfed.push(p);
  }
  check('every path something reads is written by something', unfed.length === 0,
        unfed.join(', '));
  unfed.forEach(u => note('always empty: ' + u));
  note('an empty list looks like a quiet day, which is why this one hides well');

  // What this pair cannot see: a node the Worker both writes and reads, and
  // nothing else touches. ops/cronFailure is one — the throttle reads back what
  // it wrote — so it counts as read here even while no person can see it. That
  // is a real category and it is left alone deliberately: a job keeping its own
  // state is legitimate, and flagging every instance would bury the ones that
  // matter. eta/recalMeta was in that position until analytics started reading
  // it, and it took a person asking to notice.
  note('a node the Worker writes and only the Worker reads still counts as read');
}

// The check above passes trivially if derivePaths ever returns nothing, which is
// exactly how a green tick comes to mean nothing. It has happened twice in this
// repo already — a grep that matched no lines, and a source slice that came out
// empty.
check('and the map it is derived from is not empty',
      paths.length > 40 && readable.length > 20,
      paths.length + ' paths / ' + readable.length + ' read');

// The wildcard rule is load-bearing: without it orders/active/$key reads as an
// orphan and the suite cries wolf until someone deletes the check.
check('a $key segment matches a named one',
      related('orders/active/$key', 'orders/active/chef') &&
      related('pos/bills/$key', 'pos/bills'));
check('but unrelated paths stay unrelated',
      !related('security/unpaid', 'security/voids') &&
      !related('pos/bills', 'orders/history'));

// ---------------------------------------------------------------- the map can see the writes
// A write the deriver cannot see is a path this file cannot judge, and — more to
// the point — a rule nobody reviews, since the access map is what the rules are
// checked against. Multi-path updates were entirely invisible to it: the path
// lives in the object key, not in ref().
{
  const used2 = derivePaths();
  const viaUpdate = [...used2.entries()]
    .filter(([, v]) => v.writes.some(w => w.snippet === 'multi-path update'))
    .map(([p]) => p).sort();

  check('multi-path update writes are in the map',
        viaUpdate.length >= 4,
        'found: ' + (viaUpdate.join(', ') || 'none'));
  viaUpdate.forEach(p => note('placed from an update key: ' + p));

  // Keys are relative to whatever ref .update() was called on. Filing a write
  // under the wrong path is worse than not seeing it, so the one case in the
  // repo where the base is not the root is pinned by name.
  check('and a key under a non-root ref is placed beneath it',
        viaUpdate.includes('pos/unverified/$key'),
        "db.ref('pos/unverified').update(carry) — carry's keys are children of it, not full paths");

  // What is left cannot be placed from the source: the prefix is in a variable.
  // Pinned so a new unplaceable write forces a decision rather than joining a
  // list nobody looks at.
  const unresolved = unresolvedWrites();
  check('and what it still cannot place is the set we know about',
        unresolved.length === 3 && unresolved.every(u => /^base \+/.test(u.expr)),
        unresolved.map(u => u.file + ': ' + u.expr).join('; ') || 'none');
  note('those three write state/ref/lateVerified under a ledger or unverified entry,');
  note('and both parents are in the map above — the exact child is not');
}

done();
