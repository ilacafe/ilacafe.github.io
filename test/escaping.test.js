// An ingredient called "Baker's chocolate" broke the inventory page: the name went
// straight into a JS string inside an onclick attribute, the apostrophe ended the
// string early, and the button did nothing. The page exists to press that button.
//
// The subtle half is that admin.html looked like it had handled this:
//
//     onclick="removeStaff('${key}', '${escapeHTML(name).replace(/'/g, "\\'")}')"
//
// escapeHTML has already turned every ' into &#39;, so the .replace matches nothing.
// The HTML parser then turns &#39; back into ' before the JS is compiled, and the
// string ends early anyway. It reads as belt and braces and is neither.
//
// A value here passes through two decoders — HTML, then JS — so this runs both.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Escaping — names that carry an apostrophe');

// The five entities escapeHTML emits, decoded the way a parser decodes an attribute.
const htmlDecode = s => String(s).replace(/&(amp|lt|gt|quot|#39);/g,
  (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));

// Put the value where it actually goes, then run both decoders over it and report
// what the handler would receive — or how it failed.
function throughBrowser(attrValue) {
  const attr = "handler('" + attrValue + "')";     // onclick="handler('…')"
  const js = htmlDecode(attr);                      // 1. the HTML parser
  let got, threw = null;                            // 2. the JS parser
  try { new Function('handler', js)(v => { got = v; }); }
  catch (e) { threw = e.constructor.name; }
  return { got, threw };
}

const NAMES = [
  ["an apostrophe", "Baker's chocolate"],
  ["a double quote", 'He said "hello"'],
  ["a backslash", 'a\\b'],
  ["an ampersand", 'Salt & Pepper'],
  ["angle brackets", '<script>alert(1)</script>'],
  ["a deliberate breakout", "'); alert(1); //"],
  ["an entity that is really text", '&amp; not an ampersand'],
  ["accents", 'Crème brûlée'],
];

for (const page of ['admin.html', 'inventory.html']) {
  const src = readPage(page);
  const api = buildModule([extractFunction(src, 'escapeHTML'), extractFunction(src, 'jsAttr')],
                          { String, Object }, ['escapeHTML', 'jsAttr']);
  let bad = [];
  for (const [label, name] of NAMES) {
    const r = throughBrowser(api.jsAttr(name));
    if (r.threw || r.got !== name) bad.push(label + ' (' + (r.threw || JSON.stringify(r.got)) + ')');
  }
  check(page + ': every name survives the HTML parser and the JS parser intact',
        bad.length === 0, bad.join('; '));
}

note('checked: ' + NAMES.map(n => n[0]).join(', '));

// ---------------------------------------------------------------- the old idiom really was broken
{
  const src = readPage('admin.html');
  const api = buildModule([extractFunction(src, 'escapeHTML')], { String, Object }, ['escapeHTML']);
  const oldWay = s => api.escapeHTML(s).replace(/'/g, "\\'");   // what the pages used to do

  const r = throughBrowser(oldWay("Baker's chocolate"));
  check('the idiom this replaced does fail on an apostrophe',
        r.threw === 'SyntaxError', 'if this passes, the fix was solving nothing');
  note("old idiom on \"Baker's chocolate\" → " + (r.threw || JSON.stringify(r.got)));

  const inj = throughBrowser(oldWay("'); alert(1); //"));
  check('and the same idiom let a crafted name change what runs',
        inj.threw !== null || inj.got !== "'); alert(1); //",
        'the breakout string round-tripped, so it was never exploitable this way');
}

// ---------------------------------------------------------------- no site left unescaped
{
  // A handler argument interpolated straight from a variable, with nothing applied.
  const RE = /onclick="[^"]*?\('?\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g;
  // Exempt only values that cannot carry typed text:
  //   safe / safeX  already passed through jsAttr where they are built
  //   c.id          'cat-' + category.replace(/[^a-zA-Z0-9]/g, '-') — sanitised at source
  //   bill.id       Date.now()
  //   key/uid/id    Firebase push keys and auth uids
  const SAFE = /^(jsAttr|escapeHTML|safe$|safe[A-Z]|c\.id$|bill\.id$|key$|uid$|id$|tab$|type$|index$|i$)/;
  const found = [];
  for (const page of ['admin.html', 'inventory.html', 'pos.html', 'barista.html', 'chef.html', 'index.html']) {
    const src = readPage(page);
    for (const m of src.matchAll(RE)) {
      if (!SAFE.test(m[1])) found.push(page + ': ' + m[1]);
    }
  }
  check('no handler argument is interpolated from an unescaped name',
        found.length === 0, found.join(', '));
  note('ids and indices are exempt — they are generated, not typed by anyone');

  // The allowlist above trusts any variable called safe*. That trust is only worth
  // something if such a variable is actually built with jsAttr — the old, weaker
  // `.replace(/'/g,…).replace(/"/g,…)` idiom was also called `safe` and was not.
  const weak = [];
  for (const page of ['admin.html', 'inventory.html', 'pos.html']) {
    const src = readPage(page);
    for (const m of src.matchAll(/\b(?:const|let)\s+(safe[\w$]*)\s*=\s*([^;\n]+)/g)) {
      // Only hand-rolled quote escaping counts. A safe* holding a parseFloat or a
      // fixed enum is not claiming to be escaped and is not the failure mode; a
      // .replace(/'/…) is claiming exactly that, and was wrong every time.
      if (!/\.replace\(\s*\/['"]/.test(m[2])) continue;
      if (!/jsAttr\(/.test(m[2])) weak.push(page + ': ' + m[1] + ' = ' + m[2].trim().slice(0, 60));
    }
  }
  check('and every variable the allowlist calls safe is actually built with jsAttr',
        weak.length === 0, weak.join(' | '));
}

done();
