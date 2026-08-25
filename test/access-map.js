// Prints which Realtime Database path each app reads and writes, derived from
// the source. Run it with `npm run access-map`.
//
// This is the reference to review the database rules against: a rule is only
// right if it permits exactly these and nothing more. It is generated rather
// than written down, so it cannot drift from the code that ships.

const { derivePaths, APPS } = require('./helpers');

const used = derivePaths();
const rows = [...used.keys()].sort();
const width = Math.max(...rows.map(r => r.length)) + 2;

console.log('\n\x1b[1mRealtime Database access, derived from the apps\x1b[0m\n');
console.log('  ' + 'path'.padEnd(width) + 'reads'.padEnd(38) + 'writes');
console.log('  ' + '-'.repeat(width + 76));

const short = { 'customer (anonymous)': 'anon', cashier: 'cashier', admin: 'admin',
                barista: 'barista', chef: 'chef', inventory: 'inventory' };
const fmt = set => [...set].map(r => short[r] || r).sort().join(' ') || '—';

for (const p of rows) {
  const { read, write } = used.get(p);
  // anything an unauthenticated visitor can reach is the row that matters most
  const anon = read.has('customer (anonymous)') || write.has('customer (anonymous)');
  const line = '  ' + p.padEnd(width) + fmt(read).padEnd(38) + fmt(write);
  console.log(anon ? '\x1b[33m' + line + '\x1b[0m' : line);
}

console.log('\n  ' + rows.length + ' paths across ' + Object.keys(APPS).length + ' apps.  ' +
            '\x1b[33mHighlighted\x1b[0m rows are reachable by an anonymous visitor —');
console.log('  the ordering page signs in with signInAnonymously(), so "anon" means anyone.\n');
