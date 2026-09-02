// The app says things for itself now, instead of handing off to the browser.
//
// There were 86 calls to alert(), confirm() and prompt() across five pages. On the
// devices this café actually runs — iPads, iPhones, Android phones, all opening these
// pages as standalone apps — four things are wrong with that, and only the first is
// about looks:
//
//   1. The system sheet names the site, so it reads as the browser interrupting
//      rather than the till asking. It looks like the app has broken.
//
//   2. IT STOPS THE PAGE. alert() is synchronous and blocks the event loop, so every
//      Firebase listener, timer and render is frozen until somebody taps OK. A till
//      left with an unattended alert has stopped receiving orders, payments and menu
//      changes; a kitchen board goes quietly stale. That is precisely the silent
//      failure connection.js exists to catch, caused on purpose.
//
//   3. Safari and Chrome both offer to suppress repeated alerts. One tap and every
//      later warning that session is swallowed — the error path can be switched off
//      by the person being warned.
//
//   4. It cannot show a list, carry the brand, or say which keypad to open — and
//      that last one is the whole job of a number field on a device with no keyboard.
//
// What this suite holds is the part that is easy to lose later: that none of them
// comes back, and that the thing replacing them actually behaves like a dialog —
// returns the right answer, can be cancelled, restores focus, and says which keypad
// it wants.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, readPage, suite } = require('./helpers');

const { check, note, done } = suite('Saying something — in the app, not from the browser');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'barista.html', 'chef.html', 'inventory.html'];

// ------------------------------------------------ none of them comes back
{
  // Not `.alert(` — that is `window.alert` written out, and not what this is about.
  // The comment in each page mentions alert() by name on purpose, so strip comments
  // before looking, or the check reports the explanation as the offence.
  const CALL = /(^|[^.\w])(alert|confirm|prompt)\s*\(/;
  const offenders = [];
  for (const page of PAGES) {
    const src = readPage(page)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');
    for (const line of src.split('\n')) {
      if (CALL.test(line)) offenders.push(page + ': ' + line.trim().slice(0, 70));
    }
  }
  check('no page hands off to a browser dialog any more', offenders.length === 0,
        offenders.join(' | '));
  note('a blocking dialog on a till is a till that has stopped listening');
}

// ------------------------------------------------ and the pages that need it load it
{
  const NEED = ['index.html', 'pos.html', 'admin.html', 'analytics.html', 'inventory.html'];
  const missing = NEED.filter(p => !/<script src="\/dialogs\.js"><\/script>/.test(readPage(p)));
  check('every page that says anything loads the replacement', missing.length === 0, missing.join(', '));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('no');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const threw = [];

  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => threw.push(String(e.message || e).split('\n')[0]));
  // A bare page: the module reads no page state, so it is tested on its own rather
  // than through five pages' worth of boot.
  await pg.setContent('<!doctype html><html><head><style>:root{--brand-bg:#8D6E52;--brand-text:#fff}</style></head>' +
                      '<body><button id="opener">open</button>' +
                      '<label>Note<input id="note"></label></body></html>');
  await pg.addScriptTag({ url: base + '/dialogs.js' });

  const dlg = '.ila-dialog';

  // ---- ask(): the two answers, and both ways of saying no ----
  for (const [label, act, want] of [
    ['tapping the confirming button', async () => pg.click(`${dlg} button:last-of-type`), true],
    ['tapping cancel',                async () => pg.click(`${dlg} button:first-of-type`), false],
    ['pressing Escape',               async () => pg.keyboard.press('Escape'), false],
    ['tapping the backdrop',          async () => pg.click(dlg, { position: { x: 5, y: 5 } }), false],
  ]) {
    const answer = pg.evaluate(() => window.ilaAsk('End the day?', 'Sales get archived.'));
    await pg.waitForSelector(dlg, { state: 'visible' });
    await act();
    check('ilaAsk returns ' + want + ' on ' + label, (await answer) === want, 'got the other one');
  }

  // ---- it is a real dialog, not a div that looks like one ----
  {
    const answer = pg.evaluate(() => window.ilaAsk('Void this bill?', 'It reverses ₹400.'));
    await pg.waitForSelector(dlg, { state: 'visible' });
    const shape = await pg.evaluate(() => {
      const card = document.querySelector('.ila-dialog [role="dialog"]');
      const btns = [...document.querySelectorAll('.ila-dialog button')];
      const label = card && document.getElementById(card.getAttribute('aria-labelledby'));
      return {
        modal: card && card.getAttribute('aria-modal'),
        named: !!label && label.textContent.trim(),
        focusInside: !!card && card.contains(document.activeElement),
        smallest: Math.min(...btns.map(b => Math.min(b.getBoundingClientRect().width,
                                                     b.getBoundingClientRect().height))),
        cancelFirst: btns[0] && btns[0].textContent.trim()
      };
    });
    check('it is announced as a modal dialog', shape.modal === 'true', String(shape.modal));
    check('and carries its own name', shape.named === 'Void this bill?', String(shape.named));
    check('and focus is moved into it', shape.focusInside, 'focus stayed outside');
    check('and every button is at least 44px', shape.smallest >= 44, shape.smallest + 'px');
    // The thumb is already travelling toward where the opening button was. Cancel
    // sits under it, not the answer that voids a bill.
    check('and cancel is the one nearest the thumb', shape.cancelFirst === 'Cancel', String(shape.cancelFirst));
    await pg.keyboard.press('Escape');
    await answer;
  }

  // ---- focus goes back where it came from ----
  {
    await pg.click('#opener');
    const answer = pg.evaluate(() => window.ilaAsk('Sign out?', ''));
    await pg.waitForSelector(dlg, { state: 'visible' });
    await pg.keyboard.press('Escape');
    await answer;
    const back = await pg.evaluate(() => document.activeElement && document.activeElement.id);
    check('and focus returns to whatever opened it', back === 'opener', 'landed on ' + back);
  }

  // ---- askText(): the keypad is the entire point ----
  {
    const answer = pg.evaluate(() => window.ilaAskText('Tip amount', '', { inputmode: 'decimal', value: '40' }));
    await pg.waitForSelector(dlg + ' input', { state: 'visible' });
    const mode = await pg.evaluate(() => {
      const i = document.querySelector('.ila-dialog input');
      return { inputmode: i.getAttribute('inputmode'), value: i.value, tall: i.getBoundingClientRect().height };
    });
    check('ilaAskText asks for the keypad prompt() could not', mode.inputmode === 'decimal', String(mode.inputmode));
    check('and carries the current value in', mode.value === '40', mode.value);
    check('and its field is at least 44px tall', mode.tall >= 44, mode.tall + 'px');
    await pg.fill(dlg + ' input', '55');
    await pg.click(`${dlg} button:last-of-type`);
    check('and returns what was typed', (await answer) === '55', 'got something else');
  }
  {
    const answer = pg.evaluate(() => window.ilaAskText('Reason', ''));
    await pg.waitForSelector(dlg + ' input', { state: 'visible' });
    await pg.keyboard.press('Escape');
    // null, not '' — the call sites check `=== null` to mean "they backed out", which
    // is a different thing from typing nothing.
    check('and null when it is cancelled, not an empty string', (await answer) === null, 'got a string');
  }

  // ---- tell(): one button, and it waits ----
  {
    let settled = false;
    const answer = pg.evaluate(() => window.ilaTell('Not saved', 'Check the connection.')).then(() => { settled = true; });
    await pg.waitForSelector(dlg, { state: 'visible' });
    await pg.waitForTimeout(150);
    check('ilaTell waits to be acknowledged', settled === false, 'it resolved on its own');
    const n = await pg.evaluate(() => document.querySelectorAll('.ila-dialog button').length);
    check('and offers exactly one way out', n === 1, n + ' buttons');
    await pg.click(dlg + ' button');
    await answer;
    check('and closes when it is', await pg.evaluate((s) => !document.querySelector(s), dlg), 'still on screen');
  }

  // ---- fieldError(): marks the field, says why, and clears itself ----
  {
    await pg.evaluate(() => window.ilaFieldError('note', 'Address required'));
    const marked = await pg.evaluate(() => {
      const f = document.getElementById('note');
      return { invalid: f.getAttribute('aria-invalid'), focused: document.activeElement === f,
               msg: f.nextSibling && f.nextSibling.textContent,
               role: f.nextSibling && f.nextSibling.getAttribute && f.nextSibling.getAttribute('role') };
    });
    check('ilaFieldError marks the field itself', marked.invalid === 'true', String(marked.invalid));
    check('and puts the reason beside it, announced', marked.msg === 'Address required' && marked.role === 'alert',
          marked.msg + ' / role=' + marked.role);
    check('and focuses it, so the fix is one tap away', marked.focused, 'focus went elsewhere');
    await pg.fill('#note', 'x');
    const cleared = await pg.evaluate(() => {
      const f = document.getElementById('note');
      return !f.hasAttribute('aria-invalid') && !(f.nextSibling && f.nextSibling.className === 'ila-field-error');
    });
    check('and clears as soon as they start fixing it', cleared, 'the error stayed up');
  }

  // ---- toast(): says its piece and goes ----
  {
    await pg.evaluate(() => window.ilaToast('Cart is empty'));
    const up = await pg.evaluate(() => document.body.innerText.includes('Cart is empty'));
    check('ilaToast appears without asking for anything', up, 'nothing appeared');
  }

  check('nothing threw while any of that ran', threw.length === 0, threw.join(' | '));

  await ctx.close();
  await browser.close();
  server.close();
  done();
})();
