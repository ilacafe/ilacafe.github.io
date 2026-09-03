// Two pages cached a menu under one key, and did not store the same thing.
//
// pos.html writes the menu itself. index.html writes {at, menu, order, items} so it can
// age its copy out after a week. Both used 'ila_cached_menu', on one origin — so a
// device that had opened the customer page handed the till a wrapper where a menu was
// expected, and nothing checked.
//
// Reproduced on the till before this was fixed: the wrapper's own keys were drawn as
// the categories, giving a menu of "menu" and "order" whose rows read "undefined",
// every one marked Out because a wrapper carries no inStock. Provisional refuses taps,
// so no money could move that way — but goOffline() reads the same value, calls
// buildMenuMaps on it and clears the provisional flag. A till opening disconnected on
// such a device would have had a menu with nothing sellable on it, which is precisely
// the situation that branch exists for.
//
// Two things hold it shut, and this suite checks both: the pages no longer share a key,
// and the till validates what it reads — which is what rescues a device already holding
// the wrong shape, since it recovers on the next read rather than the next online write.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Menu caches — two pages, two shapes, no shared key');

const pos = readPage('pos.html');
const idx = readPage('index.html');

// ---------------------------------------------------------------- separate keys
{
  const keyOf = (src, re) => { const m = re.exec(src.replace(/<!--[\s\S]*?-->/g, '')); return m ? m[1] : null; };
  // the till writes the menu under a literal; the ordering page under a named constant
  const tillKey = keyOf(pos, /localStorage\.setItem\('([^']+)',\s*JSON\.stringify\(currentMenuData\)/);
  const custKey = keyOf(idx, /const MENU_CACHE_KEY = '([^']+)'/);
  check('the till names the key it caches its menu under', !!tillKey, 'not found');
  check('and the ordering page names its own', !!custKey, 'not found');
  check('and they are not the same key', tillKey !== custKey,
        'both use ' + JSON.stringify(tillKey) + ' — one origin, one key, two shapes');
  note('till: ' + tillKey + '   ordering page: ' + custKey);

  // The till reads three keys; none of them may be the ordering page's.
  const readsCustKey = new RegExp("getItem\\('" + custKey + "'\\)").test(pos);
  check('and the till never reads the ordering page’s key', !readsCustKey,
        'pos.html reads ' + custKey);
}

// ---------------------------------------------------------------- the shape is checked
{
  const api = buildModule([extractFunction(pos, 'menuFromStore')], { localStorage: null }, ['menuFromStore']);
  const withStored = (value) => {
    const store = { getItem: (k) => (k === 'ila_cached_menu' ? value : null) };
    const m = buildModule([extractFunction(pos, 'menuFromStore')], { localStorage: store }, ['menuFromStore']);
    return m.menuFromStore();
  };
  check('the till has a guarded read for its cached menu', typeof api.menuFromStore === 'function');

  const MENU = { Coffee: { Latte: { price: 150, inStock: true } },
                 Food:   { Toastie: { price: 180, inStock: true } } };
  const good = withStored(JSON.stringify(MENU));
  check('a real menu is accepted, unchanged',
        !!good && Object.keys(good).join() === 'Coffee,Food', JSON.stringify(good));

  // The exact value index.html writes. `at` is a number, so it fails on the one rule.
  const wrapper = { at: Date.now(), menu: MENU, order: ['Coffee', 'Food'], items: {} };
  check('the ordering page’s wrapper is refused',
        withStored(JSON.stringify(wrapper)) === null,
        'accepted ' + JSON.stringify(withStored(JSON.stringify(wrapper))));
  note('this is the value that used to be drawn as a menu of "menu" and "order"');

  check('and so is anything else that is not categories of items', [
    ['null',        'null'],
    ['a number',    '42'],
    ['a string',    '"menu"'],
    ['an array',    '[{"Latte":{}}]'],
    ['empty',       '{}'],
    ['broken json', '{not json'],
  ].every(([, v]) => withStored(v) === null),
     [['null','null'],['a number','42'],['a string','"menu"'],['an array','[{"Latte":{}}]'],
      ['empty','{}'],['broken json','{not json']]
       .filter(([, v]) => withStored(v) !== null).map(([l]) => l).join(', '));

  // A positive test can be too strict as easily as too loose: a menu whose category is
  // empty is still a menu, and a till that refused it would lose its cache over a
  // category somebody emptied in admin.
  check('but a menu with an empty category is still a menu',
        withStored(JSON.stringify({ Coffee: { Latte: { price: 150 } }, Retired: {} })) !== null,
        'refused a menu it should have kept');
}

// ---------------------------------------------------------------- both paths use it
{
  const guarded = (pos.match(/menuFromStore\(\)/g) || []).length;
  // one definition plus the two call sites: the provisional boot and goOffline
  check('both of the till’s cached-menu reads go through it', guarded >= 3,
        guarded + ' occurrences of menuFromStore()');
  // The helper does the one raw read, which is the point of it. What must not exist is
  // a second one somewhere else — the first version of this check forbade all of them
  // and failed on the helper's own line.
  const helperSrc = extractFunction(pos, 'menuFromStore');
  const outside = pos.replace(helperSrc, '');
  check('and no OTHER place reads that key unvalidated',
        !/localStorage\.getItem\('ila_cached_menu'\)/.test(outside),
        'a raw unvalidated read exists outside menuFromStore');
  note('goOffline is the one that matters: it prices from what it reads');
}

done();
