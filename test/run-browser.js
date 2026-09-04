// The suites that need a real browser. Kept out of `npm test` because they need a
// Chromium download, which is not worth making a precondition of running the fast
// checks locally — and kept in their own runner so one failing suite still lets the
// other report.

const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  'qr-browser.test.js',
  'refused-bar-browser.test.js',
  'build-banner-browser.test.js',
  'inventory-browser.test.js',
  'worker-stall-browser.test.js',
  'walkouts-browser.test.js',
  'model-health-browser.test.js',
  'model-restore-browser.test.js',
  'push-health-browser.test.js',
  'eod-browser.test.js',
  'web-verify-claims-browser.test.js',
  'web-order-booking-browser.test.js',
  'ledger-reverify-browser.test.js',
  'web-order-billing-browser.test.js',
  'web-order-prep-gate-browser.test.js',
  'auth-gate-browser.test.js',
  'pin-mask-browser.test.js',
  'kds-board-browser.test.js',
  'boot-order-browser.test.js',
  'modal-layout-browser.test.js',
  'menu-cache-browser.test.js',
  'pos-menu-cache-browser.test.js',
  'dialog-focus-browser.test.js',
  'touch-targets-browser.test.js',
  'cart-guards-browser.test.js',
  'focus-ring-browser.test.js',
  'contrast-browser.test.js',
  'reflow-browser.test.js',
  'state-visible-browser.test.js',
  'connection-browser.test.js',
  'dialogs-browser.test.js',
  'till-dialogs-browser.test.js',
  'native-controls-browser.test.js',
  'analytics-scale-browser.test.js',
  'analytics-shell-browser.test.js',
  'analytics-drill-browser.test.js',
  'eod-summary-browser.test.js',
  'shell-cache-browser.test.js',
  'analytics-alltime-browser.test.js',
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
console.log('\x1b[32mall ' + suites.length + ' browser suites passed\x1b[0m');
