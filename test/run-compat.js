// Runs the Firebase SDK suite against a real database, in a real browser.
//
// Same shape as run-rules.js and for the same reasons: it needs a JVM, the emulator
// jar and a Chromium, none of which `npm test` should require.
//
// The rules it boots the emulator with are permissive, and that is on purpose — what
// the café's real rules permit is asked and answered in rules-emulator.test.js. This
// suite is about whether the SDK still does what seven pages assume it does, and
// mixing the two questions would only make a failure harder to read.
//
// Auth runs too. Every staff page begins with signInWithEmailAndPassword and stays
// signed in across reloads, and the till hands getIdToken() to the Worker before it
// will move cash or stock — so an SDK that loaded fine and could not sign anyone in
// would be a café that cannot open.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 9021;
const AUTH_PORT = 9099;   // the Auth emulator's own default

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ila-compat-emu-'));
fs.writeFileSync(path.join(tmp, 'permissive.rules.json'),
                 JSON.stringify({ rules: { '.read': true, '.write': true } }));
fs.writeFileSync(path.join(tmp, 'firebase.json'), JSON.stringify({
  database: { rules: 'permissive.rules.json' },
  emulators: { database: { host: '127.0.0.1', port: PORT },
               auth: { host: '127.0.0.1', port: AUTH_PORT },
               ui: { enabled: false }, singleProjectMode: true },
}));

// firebase-tools talks to the emulator over plain HTTP on 127.0.0.1. Behind a proxy
// that only serves CONNECT that comes back as the proxy's own error page and the
// rules "fail to parse", which reads exactly like a broken rules file. The suite
// itself still needs the proxy — it fetches the SDK from npm — so this strips it
// only from the CLI's own environment.
const env = Object.assign({}, process.env, {
  COMPAT_EMULATOR_PORT: String(PORT), COMPAT_AUTH_PORT: String(AUTH_PORT) });
for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) delete env[k];

const r = spawnSync(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'),
   'emulators:exec', '--only', 'database,auth', '--project', 'demo-ila',
   '--config', path.join(tmp, 'firebase.json'),
   process.execPath + ' ' + JSON.stringify(path.join(__dirname, 'firebase-compat-browser.test.js'))],
  { cwd: ROOT, stdio: 'inherit', env });

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(r.status === null ? 1 : r.status);
