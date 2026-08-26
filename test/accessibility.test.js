// index.html is the only page a customer ever sees. It is opened by scanning a QR
// code at a table, so the people using it are on their own phones, with whatever
// settings they use every day — including a screen reader, or a Bluetooth keyboard,
// or text scaled up.
//
// It was better than the review suggested: 26 real <button> elements and alt text on
// both images, which is the part most sites get wrong. What it had none of was a way
// to reach the two things built out of <div>, or a name for any field whose only
// label was a placeholder — and a placeholder is not a name, it is a hint that
// disappears the moment you type.
//
// These checks are written to catch the NEXT one, not just to record today's fix.

const { readPage, suite } = require('./helpers');

const { check, note, done } = suite('Ordering page — reachable without a mouse');

const idx = readPage('index.html');

// ---------------------------------------------------------------- everything clickable is reachable
{
  const bad = [];
  for (const m of idx.matchAll(/<(div|span|li|td)\b[^>]*onclick=[^>]*>/g)) {
    const tag = m[0];
    const missing = [];
    if (!/role="button"/.test(tag)) missing.push('role');
    if (!/tabindex="0"/.test(tag)) missing.push('tabindex');
    if (!/onkeydown=/.test(tag)) missing.push('keyboard handler');
    if (!/aria-label=/.test(tag)) missing.push('name');
    if (missing.length) bad.push(m[1] + ' missing ' + missing.join(', ') + ': ' + tag.slice(0, 70));
  }
  check('anything with a click handler can be reached and fired from a keyboard',
        bad.length === 0, bad.join(' | '));
  note('a <div onclick> is invisible to Tab and silent to a screen reader');

  // and the handler has to accept both keys a button accepts
  const handlers = [...idx.matchAll(/onkeydown="([^"]+)"/g)].map(m => m[1]);
  check('and responds to Enter and Space, as a real button would',
        handlers.length > 0 && handlers.every(h => /'Enter'/.test(h) && /' '/.test(h)),
        handlers.join(' | ').slice(0, 120));
}

// ---------------------------------------------------------------- every field has a name
{
  const labelled = new Set([...idx.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map(m => m[1]));
  const unnamed = [];
  for (const m of idx.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    const type = (/type="([^"]+)"/.exec(attrs) || [])[1];
    if (type === 'hidden') continue;
    const id = (/id="([^"]+)"/.exec(attrs) || [])[1];
    if (/aria-label=/.test(attrs) || /aria-labelledby=/.test(attrs)) continue;
    if (id && labelled.has(id)) continue;
    unnamed.push(m[1] + (id ? '#' + id : '') + (/placeholder=/.test(attrs) ? ' (placeholder only)' : ''));
  }
  check('every form control has a real accessible name', unnamed.length === 0, unnamed.join(', '));
  note('a placeholder is a hint, not a name — it is gone as soon as the field has text');
}

// ---------------------------------------------------------------- dialogs announce themselves
{
  const bad = [];
  for (const m of idx.matchAll(/<div\b[^>]*class="modal-overlay"[^>]*>/g)) {
    const tag = m[0];
    const id = (/id="([^"]+)"/.exec(tag) || [])[1] || '(unnamed)';
    if (!/role="dialog"/.test(tag)) bad.push(id + ': no role');
    else if (!/aria-modal="true"/.test(tag)) bad.push(id + ': no aria-modal');
    else if (!/aria-label=|aria-labelledby=/.test(tag)) bad.push(id + ': no name');
  }
  check('every modal is announced as a dialog, with a name', bad.length === 0, bad.join(', '));
}

// ---------------------------------------------------------------- things that change say so
{
  // The wait estimate moves as the kitchen fills up, and the payment status changes
  // on its own. Without a live region a screen reader user watches a silent screen.
  for (const id of ['status-eta-chip', 'takeaway-eta-line', 'status-detail']) {
    const tag = new RegExp('<[^>]*id="' + id + '"[^>]*>').exec(idx);
    check(id + ' announces itself when it changes',
          !!tag && /aria-live="polite"/.test(tag[0]), tag ? tag[0].slice(0, 80) : 'element not found');
  }
  note('polite, not assertive — it should not interrupt someone mid-sentence');
}

// ---------------------------------------------------------------- what was already right
{
  const imgs = [...idx.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
  check('every image still has alt text',
        imgs.every(i => /\balt=/.test(i)), imgs.filter(i => !/\balt=/.test(i)).join(', '));
  check('the page still declares its language', /<html[^>]*\blang="[a-z]{2}/.test(idx));
  note(imgs.length + ' images, ' + (idx.match(/<button\b/g) || []).length + ' real buttons');
}

done();
