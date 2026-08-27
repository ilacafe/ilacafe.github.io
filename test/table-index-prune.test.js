// The hourly prune of orders/tableIndex — the one job in this repo that deletes.
//
// The index is the public lookup a table QR uses: trackIds and timestamps, readable
// one table at a time. It exists so orders/track itself need not be enumerable, and
// it only stays worth having if it stays short — a trackId is what reads the record
// behind it, so an index that accumulates eventually hands out every id anyway, one
// table at a time.
//
// Everything in it is derived, so an entry lost is a lookup nobody makes. That is
// what makes deleting acceptable here and nowhere else in the project, and it is
// also why this suite exists: a delete that gets its cutoff wrong takes out the
// lookup for every table at once, and there is no undo.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('The table index prune — what it deletes, and what it leaves');

const src = readPage('worker/worker.js');
const keepLine = /const TABLE_INDEX_KEEP_MS = [^;]+;/.exec(src);
if (!keepLine) throw new Error('TABLE_INDEX_KEEP_MS no longer looks the way this suite reads it');

const NOW = 1756200000000;
const MIN = 60000, HOUR = 60 * MIN;

let calls, node, readOk, writeOk;
function makeApi() {
  calls = [];
  const fakeFetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push({ url: String(url), method, body: init && init.body });
    if (method === 'GET') return { ok: readOk, json: async () => node };
    return { ok: writeOk, json: async () => ({}) };
  };
  return buildModule([keepLine[0], extractFunction(src, 'pruneTableIndex')], {
    DB_URL: 'https://db.test',
    fetch: fakeFetch,
    Date: { now: () => NOW },
    Number, Object, JSON, isFinite, console,
  }, ['pruneTableIndex', 'TABLE_INDEX_KEEP_MS']);
}

const patches = () => calls.filter(c => c.method === 'PATCH');
const deleted = () => {
  const p = patches();
  if (!p.length) return [];
  const sent = JSON.parse(p[p.length - 1].body);
  return Object.keys(sent).filter(k => sent[k] === null);
};

(async () => {
  const api = makeApi();
  const KEEP = api.TABLE_INDEX_KEEP_MS;
  check('the window is hours, not minutes or days',
        KEEP >= 2 * HOUR && KEEP <= 24 * HOUR, (KEEP / HOUR) + ' hours');
  note('the customer page discards anything older than two; a day would defeat the point');

  // ------------------------------------------------------------ the ordinary run
  {
    readOk = true; writeOk = true;
    node = {
      'Table 4': {
        tRecent: NOW - 10 * MIN,          // mid-service
        tEdge:   NOW - KEEP + MIN,        // just inside the window
        tOld:    NOW - KEEP - MIN,        // just outside it
        tAncient: NOW - 40 * 24 * HOUR,
      },
      'Table 9': { tYesterday: NOW - 26 * HOUR },
    };
    const api2 = makeApi();
    const r = await api2.pruneTableIndex('robot-token');

    const gone = deleted();
    check('it deletes what has aged out',
          gone.includes('orders/tableIndex/Table 4/tOld') &&
          gone.includes('orders/tableIndex/Table 4/tAncient') &&
          gone.includes('orders/tableIndex/Table 9/tYesterday'), gone.join(', '));
    check('and leaves what is still live',
          !gone.includes('orders/tableIndex/Table 4/tRecent') &&
          !gone.includes('orders/tableIndex/Table 4/tEdge'), gone.join(', '));
    note('an entry one minute inside the window is one a customer may still be using');
    check('it says how many it took', r.pruned === 3, JSON.stringify(r));
    check('and it is one write, at the root', patches().length === 1,
          calls.map(c => c.method).join(', '));
    check('it deletes and never writes a value',
          (() => { const sent = JSON.parse(patches()[0].body);
                   return Object.values(sent).every(v => v === null); })(),
          patches()[0].body);
    note('a prune that can set a value is a prune that can corrupt what it kept');
  }

  // ---------------------------------------------------- nothing to do, no writing
  {
    readOk = true; writeOk = true;
    node = { 'Table 4': { tRecent: NOW - MIN } };
    const api2 = makeApi();
    const r = await api2.pruneTableIndex('t');
    check('a run with nothing old enough writes nothing at all',
          patches().length === 0 && r.pruned === 0, calls.map(c => c.method).join(', '));
    note('it runs every hour; a no-op run should cost a read and stop');
  }

  // ------------------------------------------------- what it refuses to guess at
  {
    readOk = true; writeOk = true;
    node = {
      'Table 4': { noStamp: null, textStamp: 'yesterday', zero: 0, negative: -1, obj: { a: 1 } },
      'Table 5': 'not an object',
      'Table 6': null,
    };
    const api2 = makeApi();
    const r = await api2.pruneTableIndex('t');
    check('an entry whose timestamp it cannot read is left alone',
          patches().length === 0 && r.pruned === 0,
          patches().length ? patches()[0].body : 'nothing written');
    note('deleting on an unreadable stamp is guessing, and the guess is unrecoverable');
  }

  // --------------------------------------------------------- when the read fails
  {
    readOk = false; writeOk = true;
    node = { 'Table 4': { tOld: NOW - 40 * HOUR } };
    const api2 = makeApi();
    const r = await api2.pruneTableIndex('t');
    check('a read it could not make deletes nothing',
          patches().length === 0 && r.pruned === 0, calls.map(c => c.method).join(', '));
    note('a denied read must not read as an empty index, which would look like nothing to keep');

    readOk = true; node = null;
    const api3 = makeApi();
    check('and an empty index is not an error either',
          (await api3.pruneTableIndex('t')).pruned === 0 && patches().length === 0);
  }

  // ------------------------------------------------------- it is wired to the cron
  {
    check('the hourly monitor runs it', /await pruneTableIndex\(token\)/.test(src));
    check('in its own try, so nothing else fails for it',
          /try \{ await pruneTableIndex\(token\); \} catch/.test(src));
    note('the payment monitor is what that cron is for; housekeeping must not break it');
  }

  done();
})();
