// Two things every page here got wrong in the same way, for the same reason: they
// are settings on the device, and the page is written on a desk where they are off.
//
// A VISIBLE FOCUS RING. All seven pages set outline:none on their text fields, and
// that is a defensible choice on its own — the default ring is a grey box that does
// not belong on the brand brown. What none of them did was replace it. The sign-in
// box is two fields stacked, Email then Password, and staff sign these tablets in
// with a Bluetooth keyboard as often as with the on-screen one. With no ring there
// was nothing to say which of the two the next keystroke was going into; a password
// typed into the email field is shown in plain text on screen, and the one clue that
// it was about to happen was the thing that had been removed.
//
// REDUCE MOTION. iOS and Android both put it two taps from the home screen, and it
// is set by people for whom a sliding panel or a pulsing card brings on nausea or a
// migraine. No page asked. The kitchen board pulses an overdue ticket once every 1.2
// seconds for as long as it is late, which on a bad Sunday is every card on the
// board, all afternoon, in the eye line of whoever is cooking.
//
// These are the questions the FILE can answer: is the rule there, is it the right
// shape, does every field have a name. Whether the ring actually reaches the screen is
// a question about the cascade, and the file is the wrong thing to ask — the first
// version of the fix had a correct `:focus-visible` rule in all seven pages and drew
// nothing on the two sign-in fields it was written for, because `#login-box input`
// carries an id and outranked it. focus-ring-browser.test.js puts that half of it to a
// browser. This half is here because it needs no Chromium download, so it runs on every
// `npm test` rather than only when someone remembers.

const { readPage, suite } = require('./helpers');

const { check, note, done } = suite('Every page — a visible focus ring, and Reduce Motion honoured');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'barista.html', 'chef.html', 'inventory.html'];
const STAFF = PAGES.filter(p => p !== 'index.html');

const src = Object.fromEntries(PAGES.map(p => [p, readPage(p)]));

// ------------------------------------------------------------------ the focus ring
// Read as rules rather than matched as one regex: `outline: none` and `outline: 2px
// solid #fff` are the same declaration with opposite meanings, and a pattern that
// tries to exclude one of them inline gets it wrong in a way that still passes.
function outlineRules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(m => ({ sel: m[1].trim(), value: (/outline\s*:\s*([^;}]+)/.exec(m[2]) || [])[1] }))
    .filter(r => r.value)
    .map(r => ({ sel: r.sel, draws: r.value.trim() !== 'none' && !/^0\b/.test(r.value.trim()) }));
}

{
  const rules = Object.fromEntries(PAGES.map(p => [p, outlineRules(src[p])]));

  const missing = PAGES.filter(p =>
    !rules[p].some(r => r.sel.includes(':focus-visible') && r.draws));
  check('every page has a rule that draws a ring on a focused control', missing.length === 0,
        missing.join(', '));
  note('that it is there — focus-ring-browser.test.js asks whether it wins');

  // :focus and not :focus-visible would put a ring under every finger on a till.
  const overEager = PAGES.filter(p =>
    rules[p].some(r => r.sel.includes(':focus') && !r.sel.includes(':focus-visible') && r.draws));
  check('and only when the browser says one is wanted, not on every tap',
        overEager.length === 0, overEager.join(', '));
  note(':focus-visible is the difference between helping a keyboard and ringing a touchscreen');

  // Any page that hides the default ring has to have put one back.
  const stripped = PAGES.filter(p => /outline:\s*none|outline: none/.test(src[p]));
  const strippedWithout = stripped.filter(p => !/:focus-visible/.test(src[p]));
  check('no page removes the default ring without replacing it',
        strippedWithout.length === 0, strippedWithout.join(', '));
  note(stripped.length + ' of ' + PAGES.length + ' pages set outline:none somewhere');
}

// -------------------------------------------------------------------- Reduce Motion
{
  const missing = PAGES.filter(p => !/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(src[p]));
  check('every page honours Reduce Motion', missing.length === 0, missing.join(', '));

  // Duration and not `animation: none`. A zero-length transition still fires and
  // still ends, so anything waiting on one keeps working and simply arrives at the
  // end state immediately — which is what was asked for. `none` deletes the event.
  const wrongShape = PAGES.filter(p => {
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\s*\}\s*\n/.exec(src[p]);
    return !block || !/animation-duration/.test(block[1]) || !/transition-duration/.test(block[1]);
  });
  check('and does it by shortening the motion rather than deleting it',
        wrongShape.length === 0, wrongShape.join(', '));
  note('a zero-length transition still ends; `animation: none` never starts');

  // The kitchen board is the one where the animation could have been carrying the
  // meaning. It is not: an overdue card is a red border and a red background too, so
  // stopping the pulse loses the movement and none of the signal.
  for (const p of ['chef.html', 'barista.html']) {
    const rule = /\.ticket-card\.overdue\s*\{([^}]*)\}/.exec(src[p]);
    check(p + ' still marks an overdue ticket without the pulse',
          !!rule && /border-color/.test(rule[1]) && /background/.test(rule[1]),
          rule ? rule[1].trim() : 'no .ticket-card.overdue rule');
  }
}

// ------------------------------------------------------------- the sign-in fields
{
  const unnamed = [];
  for (const p of STAFF) {
    for (const id of ['login-email', 'login-password']) {
      const tag = new RegExp('<input[^>]*\\bid="' + id + '"[^>]*>').exec(src[p]);
      if (!tag) { unnamed.push(p + ': no ' + id); continue; }
      if (!/aria-label=|aria-labelledby=/.test(tag[0])) unnamed.push(p + ': ' + id);
    }
  }
  check('both sign-in fields on every staff page have a real name',
        unnamed.length === 0, unnamed.join(', '));
  note('they are in a <template> with no <label>, so a placeholder was the whole of it —');
  note('and a placeholder is gone as soon as the field has text');
}

done();
