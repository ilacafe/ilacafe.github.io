// buildMenuMaps flattens the menu into the lookup tables the rest of the POS
// works from. itemPriceMap is the reference every web order is re-priced
// against, so a gap here is a hole in that check.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const win = {};
const API = buildModule(
  [extractFunction(readPage('pos.html'), 'buildMenuMaps')],
  { window: win, parseFloat },
  ['buildMenuMaps']);

const { check, done } = suite('Menu maps');

// shaped the way admin.html writes the menu
API.buildMenuMaps({
  'Coffee': {
    'Latte':     { hasSizes: true, priceReg: 250, priceLrg: 320, routing: 'barista' },
    'Cold Brew': { hasSizes: true, priceReg: 260, priceLrg: null, routing: 'barista' },
  },
  'Bakery': { 'Croissant': { price: 180, routing: 'chef' } },
  'Pizza':  { 'Truffle Pizza': { price: 640, routing: 'chef' } },
  'Odd':    { 'No Price Yet': { routing: 'chef' } },
});

check('sized item → Regular price', win.itemPriceMap['Latte (Regular)'] === 250);
check('sized item → Large price', win.itemPriceMap['Latte (Large)'] === 320);
check('plain item price', win.itemPriceMap['Croissant'] === 180);
check('a size with no price is absent, not zero',
      !('Cold Brew (Large)' in win.itemPriceMap), JSON.stringify(win.itemPriceMap['Cold Brew (Large)']));
check('the priced size is still mapped', win.itemPriceMap['Cold Brew (Regular)'] === 260);
check('an item with no price at all is absent', !('No Price Yet' in win.itemPriceMap));
check('the bare name of a sized item is not priced', !('Latte' in win.itemPriceMap));

check('routing reaches both sizes',
      win.itemRoutingMap['Latte (Large)'] === 'barista' && win.itemRoutingMap['Truffle Pizza'] === 'chef');
check('category reaches both sizes',
      win.itemCategoryMap['Latte (Regular)'] === 'Coffee' && win.itemCategoryMap['Latte (Large)'] === 'Coffee');
check('the coffee flag reaches both sizes',
      win.coffeeItemsMap['Latte (Regular)'] === true && !win.coffeeItemsMap['Croissant']);

// a deleted item must drop out on the next menu push, not linger
API.buildMenuMaps({ 'Bakery': { 'Croissant': { price: 180, routing: 'chef' } } });
check('deleted items drop out of the maps', !('Latte (Regular)' in win.itemPriceMap));
check('surviving items stay', win.itemPriceMap['Croissant'] === 180);

done();
