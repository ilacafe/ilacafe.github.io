// Why the ordering page quoted the same wait for the same basket every time.
//
// The estimate is built to move: queue depth at each station, how long the oven has
// been idle, and how fast the kitchen is actually running against what the model
// expects. All three reach the customer through one node, eta/live, published by the
// POS. The ordering page stops trusting that node once it is ETA_LIVE_STALE_MS old,
// and falls back to a neutral kitchen — no queue, tempo 1.0, a cold oven — which is
// a constant per basket.
//
// Two ways it went stale while a POS was sitting right there, open:
//
//   1. publishEtaLive() dedupes on the payload and stamps updatedAt only when
//      something changed. A steady kitchen changes nothing, so the timestamp stopped
//      advancing — during a quiet spell, which is exactly when the real numbers are
//      right and when somebody is most likely to be reading them.
//
//   2. the page compared a SERVER timestamp against the phone's own clock. A handset
//      a quarter of an hour fast read every publish as stale, permanently.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('The live ETA — why it stopped moving');

const pos = readPage('pos.html');
const idx = readPage('index.html');

// ------------------------------------------------------------------- the window
//
// It used to be fifteen minutes because fifteen minutes sounded about right, which
// is no way to decide when a wait estimate stops being a measurement. The till
// publishes how often it promises to touch updatedAt, and the page derives the
// window from that — so the two cannot drift, and changing the heartbeat on the POS
// changes the page with it.
const beat = /const ETA_HEARTBEAT_MS = (\d+)\*(\d+)/.exec(pos);
check('the POS has a heartbeat', !!beat, String(beat));
check('and publishes how often it beats', /heartbeatMs: ETA_HEARTBEAT_MS/.test(pos),
      'without this the page has nothing to derive from and falls back to a guess');

check('the page derives its window from that rather than carrying a number',
      /etaStaleWindow\(v && v\.heartbeatMs\)/.test(idx));
check('and judges the signal against the derived window',
      /\(serverNow\(\) - v\.updatedAt\) > etaStaleMs/.test(idx));

{
  const api = buildModule([
    'const ETA_LIVE_STALE_FALLBACK_MS = 15*60000;',
    'const ETA_BEATS_BEFORE_STALE = 3;',
    extractFunction(idx, 'etaStaleWindow'),
  ], { Number, Math }, ['etaStaleWindow']);

  const BEAT = beat ? Number(beat[1]) * Number(beat[2]) : 0;
  check('three missed beats, so one late heartbeat is not a shut café',
        api.etaStaleWindow(BEAT) === BEAT * 3, String(api.etaStaleWindow(BEAT)));
  note('the till beats every ' + (BEAT/60000) + ' min, so the page trusts it for ' +
       (api.etaStaleWindow(BEAT)/60000) + ' min');

  check('a till on an older build, publishing nothing, falls back rather than trusting forever',
        api.etaStaleWindow(undefined) === 15*60000 && api.etaStaleWindow(0) === 15*60000,
        String(api.etaStaleWindow(undefined)));

  // A published number is a number this page did not choose, so it is bounded.
  check('an absurdly long heartbeat cannot make the page trust a dead kitchen',
        api.etaStaleWindow(60*60000) === 30*60000, String(api.etaStaleWindow(60*60000)));
  check('nor an absurdly short one make it distrust a live one',
        api.etaStaleWindow(1000) === 5*60000, String(api.etaStaleWindow(1000)));
  note('eta/live is written by any staff role, so what it says is bounded on read');
}

// --------------------------------------------------- it refreshes only the stamp
{
  check('the heartbeat writes the timestamp and nothing else',
        /db\.ref\('eta\/live\/updatedAt'\)\.set\(firebase\.database\.ServerValue\.TIMESTAMP\)/.test(pos),
        'a heartbeat that republished the payload would undo the dedupe above it');

  check('it does not run before anything has been published',
        /if \(!window\.currentStaff \|\| !etaPubLast\) return;/.test(pos),
        'an empty eta/live with a fresh stamp is worse than an absent one — the page');
  note('would trust a queue of zero rather than fall back to the neutral estimate');

  check('and it is started', /^\s*startEtaHeartbeat\(\);/m.test(pos));
}

// ------------------------------------------------- the dedupe is still in place
{
  check('a steady kitchen still does not republish its numbers',
        /if \(sig === etaPubLast\) return;/.test(pos));
  note('the heartbeat exists so that staying quiet no longer means going stale');
}

// ------------------------------------------------------------ whose clock it is
{
  check('the page asks the connection what time the server thinks it is',
        /\.info\/serverTimeOffset/.test(idx));
  check('and judges freshness on that, not on the handset',
        /\(serverNow\(\) - v\.updatedAt\) > etaStaleMs/.test(idx),
        'Date.now() here means a phone with a wrong clock never sees a live kitchen');
  check('.info needs no rule and no sign-in, so this cannot fail closed',
        !/auth/.test((/\.info\/serverTimeOffset[^\n]*/.exec(idx) || [''])[0]));
}

// ----------------------------------------- what the fallback actually looks like
// Worth stating, because it is what the café was seeing: with the signal stale every
// live input sits at its neutral value, and a neutral kitchen is a constant.
{
  check('a stale signal leaves the queue at zero rather than guessing',
        /etaLiveFresh = false; return;/.test(idx));
  check('and the estimate does vary with the queue when it is trusted',
        /satCurveChef/.test(idx) && /satCurveBarista/.test(idx) && /ovenCurve/.test(idx),
        'load and oven idle both feed the condition term');
  note('so a constant quote is the signature of a stale node, not of a broken model');
}

done();
