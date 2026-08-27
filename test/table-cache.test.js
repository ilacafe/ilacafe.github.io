// Reloading a till during a wifi drop used to show an empty floor. The Firebase web
// SDK keeps no cache on disk — only in memory, which dies with the page — so
// window.activeTables started empty and stayed empty until the listener could reach
// the server. Every open bill vanished from the screen.
//
// The menu, the cart and the staff PINs were already mirrored to localStorage. The
// tables, the one thing made of money, were not.
//
// Restoring them introduces the opposite risk: a stale floor shown as if it were
// live. These are the guards against that, and they are the whole reason this is
// worth testing — the happy path is a JSON round trip.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const pos = readPage('pos.html');
const api = buildModule([
  'const TABLE_CACHE_MAX_AGE = 12*60*60*1000;',
  extractFunction(pos, 'packTables'),
  extractFunction(pos, 'unpackTables'),
], { JSON, Object }, ['packTables', 'unpackTables']);

const { check, note, done } = suite('Open tables — surviving a reload without lying');

const NOW = 1_700_000_000_000;
const MIN = 60000, HOUR = 60 * MIN;
const FLOOR = {
  '4':  { total: 880, paid: 0,   items: { 'Margherita': { qty: 1, price: 480 } } },
  '7':  { total: 320, paid: 320, items: { 'Latte': { qty: 1, price: 320 } } },
  'Takeaway': { total: 260, paid: 0, items: { 'Garlic Bread': { qty: 1, price: 260 } } },
};

// ---------------------------------------------------------------- it comes back
{
  const back = api.unpackTables(api.packTables(FLOOR, NOW), NOW + 5 * MIN);
  check('a floor written five minutes ago comes back intact',
        JSON.stringify(back.tables) === JSON.stringify(FLOOR), JSON.stringify(back));
  check('and reports when it was captured, so the screen can say so', back.at === NOW);
  note('three tables, including a part-paid one and a takeaway');
}

// ---------------------------------------------------------------- the guards
{
  const eleven = api.unpackTables(api.packTables(FLOOR, NOW), NOW + 11 * HOUR);
  check('eleven hours old is still offered', eleven !== null);

  const thirteen = api.unpackTables(api.packTables(FLOOR, NOW), NOW + 13 * HOUR);
  check('thirteen hours old is refused', thirteen === null,
        'a till reopened offline the next morning would show yesterday as live');

  check('a clock that jumped backwards is refused',
        api.unpackTables(api.packTables(FLOOR, NOW), NOW - HOUR) === null,
        'negative age means the timestamps cannot be trusted at all');
}

// ---------------------------------------------------------------- nothing rather than nonsense
{
  const bad = [
    ['nothing stored', null],
    ['an empty string', ''],
    ['not JSON', '{oh no'],
    ['JSON that is not an object', '"a string"'],
    ['no timestamp', JSON.stringify({ tables: FLOOR })],
    ['a timestamp that is not a number', JSON.stringify({ at: 'yesterday', tables: FLOOR })],
    ['no tables key', JSON.stringify({ at: NOW })],
    ['tables that are not an object', JSON.stringify({ at: NOW, tables: 'none' })],
    ['an empty floor', JSON.stringify({ at: NOW, tables: {} })],
  ];
  const wrong = bad.filter(([, raw]) => api.unpackTables(raw, NOW + MIN) !== null).map(([w]) => w);
  check('every damaged cache yields nothing rather than a broken floor',
        wrong.length === 0, wrong.join(', '));
  note('showing nothing is exactly the old behaviour, so the floor is never worse than before');

  check('an empty floor is not worth restoring',
        api.unpackTables(JSON.stringify({ at: NOW, tables: {} }), NOW + MIN) === null,
        'it would set the "from cache" banner with nothing to show');
}

// ---------------------------------------------------------------- wired in, not just written
{
  check('the boot path seeds activeTables from the cache',
        /window\.activeTables = restored\.tables/.test(pos));
  check('the live listener overwrites the cache on every snapshot',
        /localStorage\.setItem\(TABLE_CACHE_KEY, packTables\(window\.activeTables/.test(pos));
  check('and clears the from-cache flag, so the screen stops saying stale',
        /window\.tablesFromCacheAt = 0;\s*\n\s*try \{ localStorage\.setItem\(TABLE_CACHE_KEY/.test(pos));
  // The open tables are cleared as part of one atomic multi-path reset now rather
  // than by a remove() of their own, so this follows the reset object. What it is
  // checking is unchanged: the cache goes when the tables do.
  check('end of day removes the cache along with the tables',
        /activeTables: null[\s\S]{0,900}removeItem\(TABLE_CACHE_KEY\)/.test(pos),
        'otherwise tomorrow morning restores tonight’s closed tables');
  check('the offline banner reports the age of what it is showing',
        /tables as of/.test(pos), 'a stale floor shown as live is worse than no floor');
}

done();
