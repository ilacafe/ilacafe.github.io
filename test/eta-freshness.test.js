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

const { readPage, suite } = require('./helpers');

const { check, note, done } = suite('The live ETA — why it stopped moving');

const pos = readPage('pos.html');
const idx = readPage('index.html');

// ------------------------------------------------------------------- the window
const stale = /const ETA_LIVE_STALE_MS = (\d+)\*(\d+)/.exec(idx);
const beat  = /const ETA_HEARTBEAT_MS = (\d+)\*(\d+)/.exec(pos);
check('the ordering page still has a staleness window', !!stale, String(stale));
check('and the POS has a heartbeat to stay inside it', !!beat, String(beat));

if (stale && beat) {
  const STALE = Number(stale[1]) * Number(stale[2]);
  const BEAT  = Number(beat[1]) * Number(beat[2]);
  check('the heartbeat is comfortably faster than the window',
        BEAT * 2 <= STALE, (BEAT/60000) + ' min beat against a ' + (STALE/60000) + ' min window');
  note('one missed beat must not be enough to make a live POS look shut');
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
        /\(serverNow\(\) - v\.updatedAt\) > ETA_LIVE_STALE_MS/.test(idx),
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
