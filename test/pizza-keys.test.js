// What counts as a pizza, and the two places that used to answer it differently.
//
// The pages classify by eta/model.pizzaKeys — a list in the database, which
// admin.html can edit. The Worker's monthly refit classified by a literal of its
// own, RC_PIZZA, and nothing checked that the two agreed.
//
// The failure is asymmetric, which is why it survived. A pizza the TILL cannot
// classify is quoted the wrong prep time and somebody notices within a service. A
// pizza the REFIT cannot classify simply stops existing: it is dropped from
// pizzaBase and stops counting toward RECAL_MIN_N.pizzaBaseAll, so the refit
// declines for want of volume that is sitting in the data. Nothing throws, the
// Worker-health panel stays clean, and it reads as a quiet quarter.
//
// So this suite asks two different kinds of question. The behavioural half drives
// the real classifier. The source half asks whether the fix is still wired up at
// all — because both ways of undoing it are silent, and neither shows up as a
// failing assertion anywhere else.

const { readPage, extractFunction, buildModule, suite, stripComments } = require('./helpers');

const src = readPage('worker/worker.js');

const { check, note, done } = suite('The pizza list — one answer, not two');

main();
async function main() {

// The classifier needs its two declarations as well as its functions: the fallback
// literal and the module-level list rcIsPizza actually reads.
const decls = [
  /^const RC_PIZZA_FALLBACK\s*=.*$/m,
  /^let _rcPizzaKeys\s*=.*$/m
].map(re => {
  const m = src.match(re);
  if (!m) throw new Error('could not find a declaration the suite depends on: ' + re);
  return m[0];
});

const api = buildModule(
  [...decls, extractFunction(src, 'rcUsePizzaKeys'), extractFunction(src, 'rcIsPizza')],
  { Array, String },
  ['rcUsePizzaKeys', 'rcIsPizza', 'RC_PIZZA_FALLBACK']
);

// ---------------------------------------------------------------- it uses the model's list
{
  const source = api.rcUsePizzaKeys(['diavola', 'margherita', 'truffle & honey']);

  check('a list from the model is the list it classifies by', source === 'model');
  check('and a pizza only that list knows is a pizza',
        api.rcIsPizza('Diavola') === true,
        'this is the whole bug: Diavola matches nothing in the literal');
  check('and so is one whose name it only contains',
        api.rcIsPizza('Truffle & Honey (Large)') === true);
  check('matching is case-insensitive in both directions',
        api.rcUsePizzaKeys(['DIAVOLA']) === 'model' && api.rcIsPizza('diavola') === true);

  api.rcUsePizzaKeys(['diavola']);
  check('a name in no list is not a pizza', api.rcIsPizza('Cold Brew') === false);
  check('and neither is a name from the OLD literal, once the model has spoken',
        api.rcIsPizza('Margherita') === false,
        'the model is authoritative — the literal is not silently unioned in');
  note('the till and the refit now read the same field, so they cannot disagree');
}

// ---------------------------------------------------------------- and fails to the literal, not to nothing
//
// The dangerous failure is not "wrong list". It is "empty list": every rcIsPizza
// answers false, every pizza vanishes from the refit, and the volume gate declines
// forever with no error anywhere. A read that gives nothing must land on the
// literal instead.
{
  for (const [label, value] of [
    ['a missing field',        undefined],
    ['an explicit null',       null],
    ['an empty list',          []],
    ['not a list at all',      'margherita'],
    ['a list of non-strings',  [1, 2, {}]],
    ['a list of blank strings',['', '   ']]
  ]) {
    const source = api.rcUsePizzaKeys(value);
    check(label + ' falls back to the literal', source === 'fallback');
    check('  and the literal still classifies', api.rcIsPizza('Margherita Pizza') === true);
  }

  api.rcUsePizzaKeys(['diavola', '', '  ', 'burrata']);
  check('blank entries are dropped from an otherwise usable list',
        api.rcIsPizza('Diavola') === true && api.rcIsPizza('Burrata') === true);
  check('and a blank entry does not match everything',
        api.rcIsPizza('Cold Brew') === false,
        "''.includes() is true for every string — an unfiltered blank makes all of it pizza");
  note('an empty list would have been the same silent failure with different numbers');
}

// ---------------------------------------------------------------- the fix is still wired up
//
// Both ways of undoing this are silent. Drop the argument at the call site and
// rcDerive runs on the fallback forever; reference the literal from rcIsPizza again
// and the model's list stops mattering. Neither breaks a test that is looking
// anywhere else, and neither produces an error at runtime.
{
  const clean = stripComments(src);

  check('rcDerive takes the keys as a parameter',
        /function\s+rcDerive\s*\(\s*orders\s*,\s*pizzaKeys\s*\)/.test(clean),
        'rcDerive(orders) alone cannot be told what the model says');

  check('and settles the list before it classifies anything',
        /function\s+rcDerive\s*\([^)]*\)\s*\{\s*(?:const|let)\s+pizzaKeySource\s*=\s*rcUsePizzaKeys\(\s*pizzaKeys\s*\)/.test(clean),
        'rcAttachOvenIdle asks rcIsPizza on the first line of the derivation');

  check('the only call site passes the live model’s field',
        /rcDerive\(\s*orders\s*,\s*current\.pizzaKeys\s*\)/.test(clean),
        'without this the refit reads the model and then ignores what it says');

  const isPizza = extractFunction(src, 'rcIsPizza');
  check('rcIsPizza reads the settled list and not the literal',
        /_rcPizzaKeys\.some/.test(isPizza) && !/RC_PIZZA_FALLBACK/.test(isPizza),
        'a literal here is the shadow list coming back');

  // The old name should be gone entirely. If it returns, it returns as a second
  // opinion, which is the thing this suite exists to prevent.
  check('no RC_PIZZA constant survives beside the fallback',
        !/\bRC_PIZZA\b(?!_FALLBACK)/.test(clean));

  check('the refit reports which list it used',
        /pizzaKeySource/.test(clean) && /pizzaKeySource,/.test(clean),
        'a refit running on the fallback is not an error, but it is a fact about the numbers');
  note('a dry run now says whether it classified from the model or from this file');
}

done();
}
