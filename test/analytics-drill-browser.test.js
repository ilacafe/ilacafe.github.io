// The drill-down card opens on something.
//
// It used to open on "Select an item…": an empty stats line and no chart, every
// time, on a card whose only job is to show one. The owner had to pick before the
// card would say anything, on every single visit.
//
// What it opens on has to be the best seller BY REVENUE IN THE CHOSEN RANGE, and
// the second half of that is the part with teeth. The leader over ninety days is
// frequently not the leader over seven, so a default computed once and then carried
// forward is wrong the moment the range moves — the card would show the 30-day
// leader with "7 Days" lit above it.
//
// But an item the OWNER picked has to survive a range change, or every range button
// throws away what they were looking at. The two are told apart by where the pick
// came from: dialogs.js fires a real change event when somebody chooses from the
// list, and setting .value in code fires nothing. Only the former pins it.
//
// The fixture is built so the two answers genuinely differ — a product that sells
// steadily for months against one that only sold this week — because a fixture where
// they agree cannot tell a range-aware default from a fixed one.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Item drill-down — opens on the range’s best seller');

const DAY = 86400000;
const NOW = Date.now();

// STEADY_EARNER bills the most over 90 days. THIS_WEEK bills the most over 7.
// Neither is an accident: the whole suite turns on them being different items.
const STEADY = 'Pizza Margherita';
const RECENT = 'Cold Brew';
const FILLER = 'Toastie';

function makeHistory() {
  const h = {}; let n = 0;
  const add = (daysAgo, item, price, qty) => {
    const ts = NOW - Math.round(daysAgo * DAY);
    h[String(ts) + '_' + (n++)] = {
      items: { [item]: { qty, price } },
      payment: { total: price * qty, method: 'Cash' },
      orderType: 'Dine-in', tableOrAddress: 'T1',
      timestamp: new Date(ts).toISOString(), notes: ''
    };
  };
  // 90 days of steady pizza — 60 days back to 8 days back, so none of it is inside
  // the 7-day window at all. Five a day and not two: at two a day its 30-day total
  // came to 13,800 against the cold brew's 27,000, so the SAME item led both windows
  // and the range-tracking check below passed without testing anything. The guard at
  // the top of the run caught that; this is the fixture it demanded.
  for (let d = 60; d >= 8; d--) add(d, STEADY, 300, 5);
  // A FEW PIZZAS INSIDE THE 7-DAY WINDOW TOO, AND THEY ARE THE POINT
  // Without these the 30-day leader has NO sales in the last seven days, so it drops
  // out of that range's list and the page falls back to the top seller whether or not
  // it is tracking the range. The check for range-tracking passed with the mechanism
  // deleted — twice weakened, twice caught by reverting the code and re-running.
  // Three pizzas is enough to keep it in the 7-day list and nowhere near enough to
  // lead it, so keeping the old pick is now visibly the wrong answer.
  for (let d = 6; d >= 4; d--) add(d, STEADY, 300, 1);
  // a burst of cold brew in the last three days only
  for (let d = 3; d >= 1; d--) for (let k = 0; k < 12; k++) add(d - k * 0.05, RECENT, 250, 3);
  // something in every window so the lists are never one item long
  for (let d = 60; d >= 1; d--) add(d, FILLER, 40, 1);
  return h;
}
const HIST = makeHistory();

// Worked out here, from the same data, rather than read off the page.
function topByRevenue(days) {
  const start = days === null ? 0 : NOW - days * DAY;
  const rev = {};
  for (const id in HIST) {
    const ts = parseInt(id, 10);
    if (ts < start || ts >= NOW) continue;
    for (const nm in HIST[id].items) {
      const it = HIST[id].items[nm];
      rev[nm] = (rev[nm] || 0) + it.qty * it.price;
    }
  }
  const names = Object.keys(rev).sort((a, b) => rev[b] - rev[a]);
  return { top: names[0], rev };
}
const TOP30 = topByRevenue(30);
const TOP7 = topByRevenue(7);

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

const stub = () => `
(() => {
  const noop=()=>{}; const chain=()=>new Proxy(function(){},{get:()=>chain(),apply:()=>chain()});
  const snap=v=>({val:()=>v,exists:()=>v!=null,forEach:()=>{},numChildren:()=>v?Object.keys(v).length:0,key:null});
  const HIST=${JSON.stringify(HIST)};
  window.Chart=function(c,cfg){this.cfg=cfg;this.destroy=noop;this.update=noop;this.resize=noop;};
  window.Chart.defaults={font:{},plugins:{}}; window.Chart.register=noop;
  const mk=(q)=>({
    on:(e,cb)=>{ if(e!=='value') return cb;
      if(q==='.info/connected'){ setTimeout(()=>{try{cb(snap(true))}catch(err){}},0); return cb; }
      let v=null;
      if(q==='orders/history') v=HIST;
      else if(q==='menu') v={Food:{'${STEADY}':{price:300,routing:'chef'},'${FILLER}':{price:40,routing:'chef'}},
                             Coffee:{'${RECENT}':{price:250,routing:'barista'}}};
      setTimeout(()=>{try{cb(snap(v))}catch(err){}},30); return cb; },
    off:noop, child:()=>mk(q),
    once:()=>new Promise(r=>setTimeout(()=>r(snap(q.indexOf('users/')===0?{role:'admin',name:'A'}:null)),0)),
    limitToLast:()=>mk(q), orderByChild:()=>mk(q), orderByKey:()=>mk(q), startAt:()=>mk(q),
    push:()=>({key:'k'}), set:()=>Promise.resolve(), remove:()=>Promise.resolve(),
    update:()=>Promise.resolve(),
    transaction:(f,cb)=>{if(cb)cb(null,false,snap(null));return Promise.resolve({committed:false});}
  });
  const db={ref:p=>mk(String(p==null?'':p)), goOnline:noop, goOffline:noop};
  window.firebase={initializeApp:noop,apps:[{}],
    database:Object.assign(()=>db,{ServerValue:{TIMESTAMP:0,increment:n=>n}}),
    auth:()=>({onAuthStateChanged:cb=>setTimeout(()=>{try{cb({uid:'u1'})}catch(err){}},0),
      signInWithEmailAndPassword:()=>Promise.resolve({}),signOut:()=>Promise.resolve(),
      currentUser:{uid:'u1'}}),
    messaging:()=>({getToken:()=>Promise.resolve(null),onMessage:noop})};
  window.__stub=true;
  try{ localStorage.setItem('ila.role.v1', JSON.stringify({uid:'u1',role:'admin',name:'A'})); }catch(e){}
})();`;

const waitFor = async (tab, fn, ms) => {
  try { await tab.waitForFunction(fn, null, { timeout: ms }); return true; } catch (e) { return false; }
};

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const threw = [];

  // The fixture has to actually pose the question, or nothing below means anything.
  check('the fixture has a different revenue leader over 7 days than over 30',
        TOP7.top !== TOP30.top,
        '30d leader ' + TOP30.top + ', 7d leader ' + TOP7.top + ' — the same item proves nothing');
  note('30d: ' + JSON.stringify(TOP30.rev) + '  7d: ' + JSON.stringify(TOP7.rev));

  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(stub());
  const tab = await ctx.newPage();
  tab.on('pageerror', e => threw.push(e.message));
  tab.on('dialog', d => d.dismiss().catch(() => {}));
  await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
  await tab.goto(base + '/analytics.html', { waitUntil: 'commit' });

  const drew = await waitFor(tab, () => {
    const e = document.getElementById('k-ord');
    return e && e.textContent && e.textContent !== '0' && e.textContent !== '—';
  }, 30000);
  check('the page draws', drew, 'k-ord never filled — ' + (threw[0] || 'no error'));
  check('the stub is what it ran against', await tab.evaluate(() => window.__stub === true), '');

  const read = () => tab.evaluate(() => {
    const sel = document.getElementById('drill-select');
    const btn = sel.previousElementSibling;
    return { value: sel.value,
             options: [...sel.options].map(o => o.value),
             face: btn ? btn.textContent.replace(/[▾\s]+$/, '').trim() : null,
             stats: document.getElementById('drill-stats').textContent.trim() };
  });

  // ------------------------------------------------ it opens on something, and on the right thing
  const onLoad = await read();
  check('the drill-down opens on an item rather than an empty prompt',
        !!onLoad.value && onLoad.stats.length > 0, JSON.stringify(onLoad));
  note('it opened on "Select an item…" with a blank card every visit');
  check('and that item is the 30-day revenue leader',
        onLoad.value === TOP30.top, 'showing ' + onLoad.value + ', expected ' + TOP30.top);
  check('and no empty option is left to fall back into',
        !onLoad.options.includes(''), JSON.stringify(onLoad.options));

  // dialogs.js paints a button over the select; the two must agree
  check('the control on screen says what the chart is showing',
        onLoad.face === onLoad.value, 'button says ' + JSON.stringify(onLoad.face) +
        ', select holds ' + JSON.stringify(onLoad.value));
  note('setting .value in code does not repaint that button — __ilaSync does');

  // ------------------------------------------------ the default follows the range
  await tab.evaluate(() => document.querySelector('[data-range="7d"]').click());
  await tab.waitForTimeout(500);
  const on7d = await read();
  check('narrowing to 7 days re-picks that range’s leader',
        on7d.value === TOP7.top, 'showing ' + on7d.value + ', expected ' + TOP7.top);
  note('a default computed once would still be showing ' + TOP30.top + ' here');
  check('and the button follows it', on7d.face === on7d.value,
        'button says ' + JSON.stringify(on7d.face));

  // ------------------------------------------------ but a real choice is not overruled
  const chosen = await tab.evaluate(async () => {
    const sel = document.getElementById('drill-select');
    // The LAST option, not merely a different one. Options are sorted by revenue, so
    // the last is the weakest seller and is the leader of no range at all. Picking the
    // second option instead made this vacuous: it was the 7-day runner-up and also the
    // 30-day leader, so "kept" and "re-picked" gave the same answer and the check
    // passed with the mechanism deleted.
    const vals = [...sel.options].map(o => o.value);
    const other = vals[vals.length - 1];
    sel.value = other;
    sel.dispatchEvent(new Event('change', { bubbles: true }));   // what dialogs.js fires
    await new Promise(r => setTimeout(r, 200));
    return other;
  });
  await tab.evaluate(() => document.querySelector('[data-range="30d"]').click());
  await tab.waitForTimeout(500);
  const afterPick = await read();
  check('an item the owner chose survives a range change',
        afterPick.value === chosen,
        'chose ' + chosen + ', range change left ' + afterPick.value);
  note('otherwise every range button throws away what they were looking at');
  check('and the button still agrees', afterPick.face === afterPick.value,
        'button says ' + JSON.stringify(afterPick.face));

  // ------------------------------------------------ one order is not "1 orders"
  // This line was rarely seen before, because it only appeared once somebody had
  // chosen an item. It is on screen every visit now, so its grammar is too.
  const oneDay = new Date(NOW - 20 * DAY);
  const iso = oneDay.getFullYear() + '-' +
              String(oneDay.getMonth() + 1).padStart(2, '0') + '-' +
              String(oneDay.getDate()).padStart(2, '0');
  const single = await tab.evaluate(async (d) => {
    document.querySelector('.range-more').open = true;
    document.getElementById('date-from').value = d;
    document.getElementById('date-to').value = d;
    window.applyCustom();
    await new Promise(r => setTimeout(r, 400));
    return document.getElementById('drill-stats').textContent.trim();
  }, iso);
  check('a single order reads "1 order", not "1 orders"',
        / 1 order$/.test(single) || !/ 1 orders/.test(single),
        'the stats line reads ' + JSON.stringify(single));
  note('one day of this fixture holds exactly one order of the leading item');

  // ------------------------------------------------ a range with nothing in it
  const empty = await tab.evaluate(async () => {
    document.querySelector('.range-more').open = true;
    document.getElementById('date-from').value = '2019-01-01';
    document.getElementById('date-to').value = '2019-01-31';
    window.applyCustom();
    await new Promise(r => setTimeout(r, 400));
    const sel = document.getElementById('drill-select');
    const btn = sel.previousElementSibling;
    return { options: [...sel.options].map(o => o.text),
             stats: document.getElementById('drill-stats').textContent.trim(),
             face: btn ? btn.textContent.replace(/[▾\s]+$/, '').trim() : null };
  });
  check('a range with no sales says so instead of offering an empty list',
        empty.options.length === 1 && /no sales/i.test(empty.options[0]),
        JSON.stringify(empty.options));
  note('ilaChoose returns early on an empty option list — a select with no options is a dead control');
  check('and says it on the button too', /no sales/i.test(empty.face || ''),
        'button says ' + JSON.stringify(empty.face));
  check('and the stats line is cleared rather than left stale', empty.stats === '',
        'stats still read ' + JSON.stringify(empty.stats));

  // and it comes back
  await tab.evaluate(() => document.querySelector('[data-range="30d"]').click());
  await tab.waitForTimeout(500);
  const back = await read();
  check('and a range with sales recovers to a real item',
        !!back.value && back.stats.length > 0 && back.face === back.value, JSON.stringify(back));

  check('nothing threw', threw.length === 0, threw.slice(0, 2).join(' | '));

  await browser.close();
  server.close();
  done();
})();
