// Runs every suite that needs nothing but Node, and fails if any of them do.
// The browser suite is separate (`npm run test:browser`) because it needs a
// Chromium download, which is not worth making a precondition of running the
// fast checks locally.

const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  'syntax.test.js',
  'settlement.test.js',
  'reprice.test.js',
  'reversal.test.js',
  'unpaid-alerts.test.js',
  'menu-maps.test.js',
  'qr.test.js',
  'eta-summary.test.js',
  'eta-agreement.test.js',
  'kds-threshold.test.js',
  'kds-done.test.js',
  'rules.test.js',
  'worker.test.js',
  'cashout.test.js',
  'table-index-prune.test.js',
  'analytics-range.test.js',
  'repeat-customers.test.js',
  'unbounded-reads.test.js',
  'refused-reads.test.js',
  'eta-freshness.test.js',
  'ledger-denied.test.js',
  'late-verification.test.js',
  'escaping.test.js',
  'third-party.test.js',
  'render-blocking.test.js',
  'date-formatting.test.js',
  'table-cache.test.js',
  'inventory.test.js',
  'write-only.test.js',
  'build-freshness.test.js',
  'manifest.test.js',
  'shell-cache.test.js',
  'menu-cache-shapes.test.js',
  'analytics-agree.test.js',
  'accessibility.test.js',
  'focus-and-motion.test.js',
  'probe-reachability.test.js',
];

let failed = [];
for (const suite of suites) {
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(suite);
}

console.log('\n' + '─'.repeat(60));
if (failed.length) {
  console.log('\x1b[31m' + failed.length + ' suite(s) failed:\x1b[0m ' + failed.join(', '));
  process.exit(1);
}
console.log('\x1b[32mall ' + suites.length + ' suites passed\x1b[0m');
