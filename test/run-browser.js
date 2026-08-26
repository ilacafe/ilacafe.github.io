// The suites that need a real browser. Kept out of `npm test` because they need a
// Chromium download, which is not worth making a precondition of running the fast
// checks locally — and kept in their own runner so one failing suite still lets the
// other report.

const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  'qr-browser.test.js',
  'build-banner-browser.test.js',
  'inventory-browser.test.js',
  'walkouts-browser.test.js',
  'model-health-browser.test.js',
  'model-restore-browser.test.js',
  'push-health-browser.test.js',
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
