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

const { derivePaths, suite } = require('./helpers');

const { check, note, done } = suite('Write-only paths — recorded and unreadable');

// Written on purpose with nothing reading it back. Empty, and adding to it should
// take an argument: a record nobody can see is usually a feature half-built, not
// a decision. Each entry needs a reason.
const DELIBERATELY_WRITE_ONLY = {
  // 'some/path': 'why nothing needs to read this',
};

const used = derivePaths();
const paths = [...used.keys()];

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

const readable = paths.filter(p => used.get(p).read.size > 0);

const orphans = [];
for (const p of paths) {
  const { write } = used.get(p);
  if (!write.size) continue;
  if (p in DELIBERATELY_WRITE_ONLY) continue;
  if (readable.some(r => related(p, r))) continue;
  orphans.push(p + ' (written by ' + [...write].sort().join(', ') + ')');
}

check('every path an app writes is read back somewhere',
      orphans.length === 0,
      orphans.join('; '));
orphans.forEach(o => note('nothing can see: ' + o));

note(paths.length + ' paths, ' + readable.length + ' of them read by something');

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

done();
