// The check that catches a cron which stops firing.
//
// reportIfItThrows catches a cron that THROWS. Nothing caught one that stops
// FIRING — a schedule dropped from wrangler.toml on the next deploy, a suspended
// or over-quota Worker, a bad deploy replacing the script. In every one of those
// ops/cronFailure stays empty, no push goes out, the health panel is clean, and
// the hourly monitor has stopped. It is indistinguishable from a quiet week.
//
// So the alarm has to come from outside, and the only thing this Worker can do is
// say "I finished" to something that will notice when it stops hearing that.
//
// Everything below is about the ways that ping could make things WORSE than not
// having it, because a monitor that breaks the thing it monitors is a bad trade:
//   - a ping that hangs, inside a waitUntil, holding the invocation open
//   - a ping failure turning a successful job into a reported failure
//   - a ping that fires even when the job threw, which is a green tick over a
//     dead cron — the exact state this exists to detect
//   - an unset binding behaving like anything other than "no monitor attached"

const { readPage, extractFunction, buildModule, suite, stripComments } = require('./helpers');

const src = readPage('worker/worker.js');

const { check, note, done } = suite('The heartbeat — a cron that stops firing');

main();
async function main() {

// A fetch stub that records what it was asked for, and can be told to hang or
// throw. AbortSignal.timeout is real, so a hang is cut off by the code's own
// bound rather than by anything this file does.
function harness(mode){
  const calls = [];
  const fetchStub = (url, opts) => {
    calls.push({ url: String(url), method: opts && opts.method, signal: opts && opts.signal });
    if (mode === 'throw') return Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    if (mode === 'hang') return new Promise((_, reject) => {
      const sig = opts && opts.signal;
      if (sig) sig.addEventListener('abort', () => reject(new Error('aborted')));
    });
    return Promise.resolve({ ok: true, status: 200 });
  };
  return { calls, fetchStub };
}

function build(url, mode){
  const { calls, fetchStub } = harness(mode);
  const api = buildModule(
    ['let HEARTBEAT_URL = ' + JSON.stringify(url) + ';',
     src.match(/^const HEARTBEAT_TIMEOUT_MS = .*$/m)[0],
     extractFunction(src, 'heartbeat')],
    { fetch: fetchStub, URL, AbortSignal, console, String, TypeError },
    ['heartbeat']
  );
  return { api, calls };
}

// ---------------------------------------------------------------- it pings, per job
{
  const { api, calls } = build('https://hc-ping.com/abc123');
  await api.heartbeat('monitor');
  await api.heartbeat('recalibration');

  check('a finished job pings', calls.length === 2);
  check('and the job name is the last path segment',
        calls[0].url === 'https://hc-ping.com/abc123/monitor' &&
        calls[1].url === 'https://hc-ping.com/abc123/recalibration',
        calls.map(c => c.url).join(' | '));
  note('two crons an hour and a month apart cannot share one check');

  const trailing = build('https://hc-ping.com/abc123/');
  await trailing.api.heartbeat('monitor');
  check('a trailing slash on the binding does not double up',
        trailing.calls[0].url === 'https://hc-ping.com/abc123/monitor',
        trailing.calls[0].url);

  check('it is a POST', calls[0].method === 'POST');
  check('and it is bounded', !!calls[0].signal, 'no AbortSignal was passed');
}

// ---------------------------------------------------------------- an unset binding is not an error
//
// This is the difference from authOk, and it is deliberate. A missing secret
// there would open a route. A missing URL here only declines to send a ping
// nobody is listening for — so the Worker has to run exactly as it did before
// this existed, or attaching a monitor becomes its own deployment risk.
{
  for (const [label, value] of [
    ['unset',        undefined],
    ['null',         null],
    ['empty string', ''],
    ['a number',     8080]
  ]) {
    const { api, calls } = build(value);
    let threw = null;
    try { await api.heartbeat('monitor'); } catch(e){ threw = e; }
    check('a binding that is ' + label + ' sends nothing and does not throw',
          calls.length === 0 && threw === null, threw && threw.message);
  }
}

// ---------------------------------------------------------------- it will not POST anywhere
{
  const bad = build('http://hc-ping.com/abc123');
  await bad.api.heartbeat('monitor');
  check('a non-https binding is refused', bad.calls.length === 0);
  note('this Worker POSTs to whatever the binding says, so it does not get to be http');

  const junk = build('not a url at all');
  let threw = null;
  try { await junk.api.heartbeat('monitor'); } catch(e){ threw = e; }
  check('an unparseable binding is refused rather than thrown',
        junk.calls.length === 0 && threw === null, threw && threw.message);

  const slashy = build('https://hc-ping.com/abc123');
  await slashy.api.heartbeat('../../evil');
  check('a job name cannot climb out of the path',
        slashy.calls[0].url === 'https://hc-ping.com/abc123/..%2F..%2Fevil',
        slashy.calls[0].url);
}

// ---------------------------------------------------------------- it cannot break the job it reports on
{
  const dead = build('https://hc-ping.com/abc123', 'throw');
  let threw = null;
  try { await dead.api.heartbeat('monitor'); } catch(e){ threw = e; }
  check('a refused ping does not propagate', threw === null, threw && threw.message);
  note('a monitor that fails the job it monitors is a worse trade than no monitor');

  const hung = build('https://hc-ping.com/abc123', 'hang');
  const started = Date.now();
  // AbortSignal.timeout() does not hold Node's event loop open. Without a ref'd
  // timer here the loop drains while this await is pending, the process exits 0
  // in the middle of the suite, and run.js reports it as a pass — which is how
  // the guard now at the top of suite() came to exist.
  const keepAlive = setInterval(() => {}, 250);
  let hungThrew = null;
  try { await hung.api.heartbeat('monitor'); } catch(e){ hungThrew = e; }
  clearInterval(keepAlive);
  const waited = Date.now() - started;
  check('a ping that connects and goes nowhere gives up', hungThrew === null && waited < 8000,
        'waited ' + waited + 'ms');
  check('and it gives up on its own bound, not by luck', waited >= 4500, 'waited ' + waited + 'ms');
  note('this call sits inside waitUntil — unbounded, it would hold open the invocation it reports on');
}

// ---------------------------------------------------------------- it fires only after a run that finished
//
// The source half, because the placement is the whole design and no stub can see
// it: a ping from the catch, or before the work, is a green tick over a dead
// cron — which is the state this exists to detect.
{
  const clean = stripComments(src);
  const body = clean.match(/async function reportIfItThrows[\s\S]*?\n\}/);
  check('reportIfItThrows was found to read', !!body);

  if (body) {
    const text = body[0];
    const catchAt = text.indexOf('catch(e){');
    const pingAt  = text.indexOf('heartbeat(job)');
    const returnResultAt = text.lastIndexOf('return result;');

    check('the ping is in reportIfItThrows at all', pingAt > -1);
    check('and it is not inside the failure path', pingAt > text.indexOf('return { ran:false, threw:true'),
          'a ping from the catch reports a dead cron as healthy');
    check('and it is the last thing before the successful return',
          pingAt > -1 && returnResultAt > pingAt,
          'a ping before the work says the Worker is alive, not that the job ran');
    check('it is awaited', /await\s+heartbeat\(job\)/.test(text));
    void catchAt;
  }

  check('both scheduled jobs go through reportIfItThrows, so both are covered',
        (clean.match(/reportIfItThrows\('recalibration'/) || []).length === 1 &&
        (clean.match(/reportIfItThrows\('monitor'/) || []).length === 1);
  note("the check slugs are those two strings — 'monitor' and 'recalibration'");
}

done();
}
