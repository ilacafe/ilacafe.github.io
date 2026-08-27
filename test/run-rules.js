// Runs the rules suite against database.rules.json in the Firebase emulator.
//
// Kept out of `npm test` for the same reason the browser suite is: it needs
// something the fast checks should not require — here a JVM and the emulator jar,
// which firebase-tools downloads on first run.
//
// emulators:exec boots the emulator, runs the command, and shuts down whatever the
// command's exit code is, so a failing suite cannot leave a database listening.

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// firebase-tools talks to the emulator over plain HTTP on 127.0.0.1. Behind a
// proxy that only serves CONNECT, that request comes back as the proxy's own
// error page and the rules "fail to parse" — which reads exactly like a broken
// rules file. Strip the proxy for this process; nothing here leaves the machine.
const env = Object.assign({}, process.env);
for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) delete env[k];

// demo- prefixed projects put the CLI in offline mode: no login, no project lookup.
const r = spawnSync(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'),
   'emulators:exec', '--only', 'database', '--project', 'demo-ila',
   '--config', path.join(ROOT, 'firebase.json'),
   process.execPath + ' ' + JSON.stringify(path.join(__dirname, 'rules-emulator.test.js'))],
  { cwd: ROOT, stdio: 'inherit', env });

process.exit(r.status === null ? 1 : r.status);
