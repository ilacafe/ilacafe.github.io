// A refusal is only evidence if it came from the database.
//
// tools/probe-rules.js runs after a rules deploy and asks the live database, with
// no credentials, what a stranger can read. Most of it reads a refusal as a pass —
// twenty-odd paths that must be denied, each one confirmed by a 401.
//
// That reasoning holds exactly as long as the refusals are Firebase's. Every way of
// NOT reaching Firebase also produces refusals: a proxy that denies the host, a
// network policy, a gateway, a DNS answer that goes nowhere. Run without a route to
// the database, every path is "denied", every deny-list line prints OK, and the
// report is a clean bill of health for a database the process never spoke to.
//
// Found by running it inside a sandbox whose egress proxy answers 403 to CONNECT.
// All six public paths failed — loudly, which is what saved it — and all twenty-two
// forbidden ones passed. The half that matters most is the half that fails
// safe-looking, and it is the half nobody reads when the summary says FAIL above it.
//
// The fix is a positive control: at least one public path must answer 200 before any
// refusal below is read as a pass. This drives the real script against a stub that
// answers the way each of those worlds answers, and checks the verdict.

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The deploy probe — an unreachable database is not a locked one');

const probe = require('../tools/probe-rules.js');

// The same two lists the probe builds, so the stub can answer each path the way the
// scenario says it would. Which paths those are is rules.test.js's question, not
// this one — here they are only addresses to answer at.
const open = probe.publicPaths(probe.readRules()).map(probe.toDbPath);
const denied = probe.MUST_BE_DENIED
  .concat(probe.ancestorsOf(probe.publicPaths(probe.readRules())))
  .map(probe.toDbPath);

// `GET /menu.json?shallow=true` -> `menu`; `GET /.json` -> `` (the root).
function dbPath(url) {
  return new URL(url, 'http://x').pathname.replace(/^\//, '').replace(/\.json$/, '');
}

// Connection: close on every reply, because the probe uses fetch and fetch pools
// its sockets. A stub left holding a keep-alive connection keeps BOTH processes'
// event loops alive, and the suite hangs rather than failing — which is how this
// harness announced itself the first time.
function serve(answer) {
  const server = http.createServer((req, res) => {
    const code = answer(dbPath(req.url));
    res.writeHead(code, { 'Content-Type': 'application/json', 'Connection': 'close' });
    res.end(code === 200 ? 'null' : '{"error":"Permission denied"}');
  });
  server.keepAliveTimeout = 1;
  return server;
}

async function withStub(answer, fn) {
  const server = serve(answer);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    return await fn('http://127.0.0.1:' + server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
}

// The script, run the way the workflow runs it, pointed at the stub.
//
// spawn and not spawnSync, and this is the whole reason the first draft of this
// suite timed out four times over: the stub server runs in THIS process, and
// spawnSync blocks this process's event loop. The probe's very first request sat
// unanswered until the kill timer fired, because nothing was left running to answer
// it. Asynchronous, the loop stays free to serve.
//
// The timeout is a backstop: a probe that hangs should fail this suite, not stall it.
function runProbe(base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'probe-rules.js')],
                        { env: { ...process.env, DB_URL: base } });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}

(async () => {
  // ------------------------------------------------ nothing is reachable at all
  // Every path refused, which is what a blocked host looks like from in here.
  {
    const { code, out } = await withStub(() => 403, runProbe);

    check('a database that refuses everything fails the run', code === 1, 'exit ' + code);
    check('and says the reason is that it was never reached',
          /not reaching the database/i.test(out), out.slice(-300));

    // The whole point. Before the fix this section printed OK twenty-two times.
    check('and does not go on to report on refusals it cannot attribute',
          !/what a stranger cannot/i.test(out),
          'the deny-list section was printed anyway');
    check('and says plainly that nothing was verified',
          /NOT verified/i.test(out), out.slice(-200));
    note('a refusal from a proxy and a refusal from Firebase are the same status code');
  }

  // ------------------------------------------------------- a healthy database
  {
    const { code, out } = await withStub(p => (open.includes(p) ? 200 : 401), runProbe);

    check('a database answering the way a correct one would passes',
          code === 0, 'exit ' + code + '\n' + out.slice(-400));
    check('and does reach the deny list', /what a stranger cannot/i.test(out));
    note(open.length + ' public paths, ' + denied.length + ' that must be refused');
  }

  // ------------------------------------- reachable, and leaking: still caught
  // The gate must not swallow the finding it was built around. One forbidden path
  // answering 200, with the public surface healthy, is the original bug.
  {
    const leak = denied.find(p => p !== '');
    const { code, out } = await withStub(p => (open.includes(p) || p === leak ? 200 : 401), runProbe);

    check('a reachable database that leaks a forbidden path still fails',
          code === 1, 'exit ' + code);
    check('and names the path that is readable',
          new RegExp(leak + ' IS READABLE BY ANYONE').test(out), out.slice(-300));
    note('the control is a precondition, not a substitute for the check');
  }

  // ------------------------------- one public path down, the rest reachable
  // Not the same thing as unreachable, and it must not be treated as such: it is a
  // real finding about the rules, and the deny list is still worth reading.
  {
    // Every public path answers except the first, which refuses like a denied one.
    const down = open[0];
    const { code, out } = await withStub(p => (open.includes(p) && p !== down ? 200 : 401), runProbe);

    check('one public path refusing is a failure about the rules', code === 1, 'exit ' + code);
    check('and is not reported as unreachable',
          !/not reaching the database/i.test(out), 'it blamed the network');
    check('and the deny list is still checked',
          /what a stranger cannot/i.test(out), 'the deny list was skipped');
    note('the control only trips when NOT ONE public path answered');
  }

  done();
})();
