// A payment that was still unverified when the day closed, and paid afterwards.
//
// EOD writes the archive FIRST and parks the stragglers second, so the archived
// ledger records them as unverified. That is correct — it is what was true at
// closing. But when a bank credit finally matches, the reconciler marks the parked
// row verified and nothing ever tells the archive. The archive says the money never
// came; the parked row says it did; and that row is the only copy.
//
// Two things this has to get right, and they pull against each other:
//
//   the archive must end up carrying the correction, or an audit of that day is
//   simply wrong about whether the café was paid;
//
//   the parked row must not be deleted on the strength of a write this code
//   merely believes landed.
//
// So: append to the archive, never rewrite it, and delete the row only on a LATER
// run, after a fresh read shows the correction is really there.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Late verifications — the day says it was paid');

const src = readPage('worker/worker.js');

const DAY = '2026-08-27';
const ARCHIVE = DAY + '-1756200000000';

let db, calls, failWrites;
function run(carried, archived) {
  calls = [];
  db = { carried: JSON.parse(JSON.stringify(carried)), archived: JSON.parse(JSON.stringify(archived)) };

  const fakeFetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const u = String(url);
    calls.push({ method, url: u, body: init && init.body });

    if (method === 'GET' && u.indexOf('/pos/unverified.json') >= 0)
      return { ok: true, json: async () => db.carried };
    if (method === 'GET' && u.indexOf('/pos/eodArchive.json?shallow=true') >= 0)
      return { ok: true, json: async () => Object.keys(db.archived).reduce((a, k) => (a[k] = true, a), {}) };

    const m = /\/pos\/eodArchive\/([^/]+)\/lateVerified\/([^.]+)\.json/.exec(u);
    if (m) {
      const key = decodeURIComponent(m[1]), payId = decodeURIComponent(m[2]);
      if (method === 'GET') return { ok: true, json: async () => (db.archived[key] || {})[payId] || null };
      if (method === 'PUT') {
        if (failWrites) return { ok: false, json: async () => ({}) };
        db.archived[key] = db.archived[key] || {};
        db.archived[key][payId] = JSON.parse(init.body);
        return { ok: true, json: async () => ({}) };
      }
    }
    const d = /\/pos\/unverified\/([^.]+)\.json/.exec(u);
    if (d && method === 'DELETE') { delete db.carried[decodeURIComponent(d[1])]; return { ok: true, json: async () => ({}) }; }
    return { ok: false, json: async () => null };
  };

  const api = buildModule([
    'const DB_URL = "https://db.test";',
    extractFunction(src, 'monLoad'),
    extractFunction(src, 'settleLateVerifications'),
  ], { fetch: fakeFetch, Object, JSON, String, Number, Date, console, encodeURIComponent },
     ['settleLateVerifications']);
  return api.settleLateVerifications('tok');
}

const PAID = { amount: 450, reason: 'Table 6 (UPI)', ts: 1756100000000, bankTag: 'yes 8020',
               day: DAY, state: 'verified', ref: '512345678901', verifiedAt: 1756290000000 };
const STILL_OWED = { amount: 300, reason: 'Table 2 (UPI)', ts: 1756100000001, bankTag: 'yes 8020',
                     day: DAY, state: 'unverified' };

(async () => {
  failWrites = false;

  // ------------------------------------------------ first run: record, do not clear
  {
    const r = await run({ pay1: PAID, pay2: STILL_OWED }, { [ARCHIVE]: {} });
    check('the correction is written into the day it belongs to',
          !!db.archived[ARCHIVE].pay1 && db.archived[ARCHIVE].pay1.ref === '512345678901',
          JSON.stringify(db.archived[ARCHIVE]));
    check('carrying the reference, the amount and when it landed',
          db.archived[ARCHIVE].pay1.amount === 450 && db.archived[ARCHIVE].pay1.at === 1756290000000,
          JSON.stringify(db.archived[ARCHIVE].pay1));
    check('and the parked row is still there afterwards',
          !!db.carried.pay1 && r.cleared === 0, JSON.stringify(r));
    note('nothing is deleted in the run that wrote it — the next run re-reads the');
    note('archive, and only a read that comes back with the correction clears the row');
    check('a payment still owed is left completely alone',
          !!db.carried.pay2 && !db.archived[ARCHIVE].pay2, JSON.stringify(db.carried.pay2));
    check('it says what it did', r.recorded === 1, JSON.stringify(r));
  }

  // ------------------------------------------------- second run: now it is cleared
  {
    const r = await run({ pay1: PAID, pay2: STILL_OWED },
                        { [ARCHIVE]: { pay1: { ref: '512345678901', at: 1756290000000, amount: 450 } } });
    check('the run after that clears the row', !db.carried.pay1 && r.cleared === 1, JSON.stringify(r));
    check('and does not write the correction twice', r.recorded === 0, JSON.stringify(r));
    check('the archive keeps it', !!db.archived[ARCHIVE].pay1);
    check('and the one still owed survives', !!db.carried.pay2);
  }

  // -------------------------------------------------------- a write that failed
  {
    failWrites = true;
    const r = await run({ pay1: PAID }, { [ARCHIVE]: {} });
    check('a correction that could not be written clears nothing',
          !!db.carried.pay1 && r.cleared === 0 && r.recorded === 0, JSON.stringify(r));
    note('this is the case the two-run rule exists for: the only copy must outlive');
    note('every failure that can happen between reading it and archiving it');
    failWrites = false;
  }

  // ------------------------------------------------- no archive for that day yet
  {
    const r = await run({ pay1: PAID }, {});
    check('a day with no archive at all is left for a human',
          !!db.carried.pay1 && r.recorded === 0 && r.cleared === 0, JSON.stringify(r));
    note('deleting here would throw away the only record of a payment that arrived');
  }

  // ------------------------------------------- a day closed twice takes the later
  {
    const early = DAY + '-1756200000000', late = DAY + '-1756280000000';
    await run({ pay1: PAID }, { [early]: {}, [late]: {} });
    check('when a day was closed twice the correction goes on the later archive',
          !!db.archived[late].pay1 && !db.archived[early].pay1,
          'early=' + JSON.stringify(db.archived[early]) + ' late=' + JSON.stringify(db.archived[late]));
    note('the second close is the one that carries the payment');
  }

  // ------------------------------------------------------------ it never rewrites
  {
    await run({ pay1: PAID }, { [ARCHIVE]: {} });
    const touched = calls.filter(c => c.method === 'PUT' || c.method === 'PATCH' || c.method === 'DELETE')
                         .map(c => c.url.replace('https://db.test', ''));
    const intoLedger = touched.filter(u => /eodArchive/.test(u) && !/lateVerified/.test(u));
    check('it writes nowhere in an archive except lateVerified',
          intoLedger.length === 0, intoLedger.join(', '));
    note('what was archived is what was true at closing, and stays that way — the');
    note('correction sits beside it rather than on top of it');
  }

  // ------------------------------------------------------ cheap enough to run hourly
  {
    check('the archive is read for keys only, never whole',
          /eodArchive\.json\?shallow=true/.test(src),
          'reading it whole means every bill of every day the café has been open, hourly');
    check('and it is wired into the hourly run in its own try',
          /try \{ await settleLateVerifications\(token\); \} catch/.test(src));
    note('it moves an audit record, so a failure must not take the payment alerts with it');
  }

  done();
})();
