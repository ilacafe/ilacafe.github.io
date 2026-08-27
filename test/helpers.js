// Shared plumbing for the suites.
//
// The apps are single-file by design: there is no build step and no module
// system, so the code under test lives inside <script> in a .html page. These
// helpers lift named functions straight out of that source and run them, rather
// than testing a copy — a copy drifts, and a test that passes against a stale
// copy is worse than no test.
//
// The trade-off is that renaming or moving a tested function breaks extraction.
// That is deliberate: it fails loudly, naming the function it could not find,
// instead of quietly testing something that no longer ships.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readPage(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

// Walk to the brace that closes the one at openIdx, stepping over strings,
// template substitutions, comments and regex literals.
//
// Regex literals matter: escapeHTML is `.replace(/[&<>"']/g, …)`, and reading that
// quote as the start of a string walks off the end of the function and silently
// extracts the next several functions with it. That failed loudly here, but only
// because the extra code referenced `window`.
function matchBraces(src, openIdx) {
  let depth = 0, i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === '/' && startsRegex(src, i)) { i = skipRegex(src, i); continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  throw new Error('unbalanced braces from offset ' + openIdx);
}

// `/` is division after a value and a regex after an operator. Looking back at the
// last significant character separates the two — the standard heuristic, and exact
// for every shape that appears in these pages.
function startsRegex(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  if ('(,=:[!&|?{};+-*%~^'.includes(src[j])) return true;
  const word = /[A-Za-z_$][\w$]*$/.exec(src.slice(0, j + 1));
  return !!word && ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'void', 'delete']
    .includes(word[0]);
}

// From the opening slash to the one that closes it. A `/` inside a character class
// is literal, so the class has to be tracked or `/[&<>"']/` ends at the wrong place.
function skipRegex(src, i) {
  i++;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { i++; break; }
    else if (c === '\n') break;
    i++;
  }
  while (i < src.length && /[gimsuyvd]/.test(src[i])) i++;   // flags
  return i;
}

function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    if (quote === '`' && src[i] === '$' && src[i + 1] === '{') { i = matchBraces(src, i + 1); continue; }
    i++;
  }
  throw new Error('unterminated string from offset ' + i);
}

// Source text of `function <name>(...) { ... }`, braces balanced. `async` is
// captured when present — dropping it would silently turn an async function into
// a sync one that returns a Promise nobody awaits.
function extractFunction(src, name) {
  const re = new RegExp('(?:^|\\n)\\s*(async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) {
    throw new Error(
      'could not find function ' + name + '() in the page.\n' +
      'It was renamed, moved, or turned into an expression — update the suite ' +
      'that reads it so the tests keep covering the code that actually ships.');
  }
  const start = src.indexOf(m[1] ? 'async' : 'function', m.index);
  const open = src.indexOf('{', src.indexOf('(', start));
  return src.slice(start, matchBraces(src, open));
}

// Source text of `window.<name> = function (...) { ... }` — the pages assign most of
// their public entry points that way rather than declaring them, so extractFunction
// cannot see them.
//
// `async` is captured when present, for the reason extractFunction gives: dropping it
// turns an async function into a sync one returning a Promise nobody awaits. This did
// not handle it, so every async entry point — refundDone, voidBill, promptEOD — simply
// could not be reached from a suite at all.
function extractAssignedFunction(src, name) {
  const re = new RegExp('window\\.' + name + '\\s*=\\s*(async\\s+)?function');
  const m = re.exec(src);
  if (!m) {
    throw new Error(
      'could not find window.' + name + ' = function(...) in the page.\n' +
      'It was renamed or turned into a declaration — update the suite that reads it.');
  }
  const open = src.indexOf('{', src.indexOf('(', m.index));
  return (m[1] ? 'async ' : '') + 'function ' + name +
         src.slice(src.indexOf('(', m.index), open) +
         src.slice(open, matchBraces(src, open));
}

// Build a callable module from extracted sources. `globals` are the names the
// extracted code closes over (db, window, firebase, …) supplied as stubs.
function buildModule(sources, globals, exportNames) {
  const names = Object.keys(globals);
  const body = sources.join('\n') +
    '\nreturn {' + exportNames.map(n => n + ': ' + n).join(', ') + '};';
  return new Function(...names, body)(...names.map(n => globals[n]));
}

// The QR encoder is an IIFE inside pos.html that exports to module.exports when
// one exists and to window otherwise. `module` is shadowed as undefined so it
// takes the window branch and we get the same object a browser would.
function loadQrEncoder(opts) {
  const src = readPage('pos.html');
  const start = src.indexOf('// ===== QR ENCODER');
  if (start < 0) throw new Error('QR encoder block not found in pos.html');
  const end = src.indexOf('let qrToken = 0;', start);
  if (end < 0) throw new Error('could not find the end of the QR encoder block in pos.html');
  let body = src.slice(start, end);

  // Forcing a mask is only for the reference comparison: two encoders can pick
  // different (both valid) masks, and comparing modules is only meaningful when
  // both are masked the same way.
  if (opts && opts.forceableMask) {
    const patches = [
      ['function encode(text) {', 'function encode(text, _forcedMask) {'],
      ['return buildMatrix(allCodewords, ver);', 'return buildMatrix(allCodewords, ver, _forcedMask);'],
      ['function buildMatrix(codewords, ver) {', 'function buildMatrix(codewords, ver, _forcedMask) {'],
      ['for (var m = 0; m < 8; m++) {',
       'for (var m = (_forcedMask == null ? 0 : _forcedMask); m < (_forcedMask == null ? 8 : _forcedMask + 1); m++) {'],
    ];
    for (const [from, to] of patches) {
      if (!body.includes(from)) {
        throw new Error('QR encoder no longer contains ' + JSON.stringify(from) +
          ' — the mask-forcing patch in test/helpers.js needs updating.');
      }
      body = body.replace(from, to);
    }
  }

  const root = {};
  new Function('window', 'module', 'globalThis', body)(root, undefined, root);
  if (!root.ilaQR) throw new Error('the QR encoder did not export ilaQR');
  return root.ilaQR;
}

// A rules file is JSON *with comments* — Firebase accepts them and its own
// getRules() returns "the rules source including comments", so an exported file
// very plausibly has them. Strip them before parsing, tracking string state so a
// // inside a rule expression is not mistaken for a comment.
function stripComments(text) {
  let out = '', i = 0, inString = false;
  while (i < text.length) {
    const c = text[i], next = text[i + 1];
    if (inString) {
      if (c === '\\') { out += c + (next || ''); i += 2; continue; }
      if (c === '"') inString = false;
      out += c; i++; continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === '/' && next === '/') { const nl = text.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (c === '/' && next === '*') { const end = text.indexOf('*/', i); if (end < 0) break; i = end + 2; continue; }
    out += c; i++;
  }
  return out;
}

// Minimal reporter. Suites print one line per check and exit non-zero on failure.
function suite(title) {
  let pass = 0, fail = 0;
  console.log('\n\x1b[1m' + title + '\x1b[0m\n');
  return {
    check(name, ok, detail) {
      if (ok) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
      else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + name + (detail ? '  → ' + detail : '')); }
      return !!ok;
    },
    note(text) { console.log('       \x1b[2m' + text + '\x1b[0m'); },
    done() {
      console.log('\n' + (fail === 0
        ? '\x1b[32m' + pass + ' passed\x1b[0m'
        : '\x1b[31m' + fail + ' FAILED\x1b[0m, ' + pass + ' passed'));
      process.exitCode = fail ? 1 : 0;
      return { pass, fail };
    }
  };
}


// ---------------------------------------------------------------- data access
// Which Realtime Database paths each app touches, and how. Derived from the
// source rather than maintained by hand, so it cannot drift from what ships.
// Used by the rules check and by `npm run access-map`.
const APPS = {
  'index.html':     'customer (anonymous)',
  'pos.html':       'cashier',
  'admin.html':     'admin',
  'analytics.html': 'admin',
  'barista.html':   'barista',
  'chef.html':      'chef',
  'inventory.html': 'inventory',
};

const OPS = [
  [/\.set\s*\(/, 'write'], [/\.push\s*\(/, 'write'], [/\.update\s*\(/, 'write'],
  [/\.remove\s*\(/, 'write'], [/\.transaction\s*\(/, 'write'],
  [/\.on\s*\(/, 'read'], [/\.once\s*\(/, 'read'],
];

// A multi-path update writes several paths at once through a single ref:
//
//     updates[`inventory/stock/${item}`] = increment(n);
//     db.ref().update(updates);
//
// The path is in the object key, not in ref(), so the db.ref('literal') scan below
// cannot see any of it. Real writes were invisible for this reason, and the access
// map is what the database rules get reviewed against — a write nobody can see is
// a rule nobody checks.
//
// The keys are relative to whatever ref .update() was called on, which is not
// always the root:
//
//     db.ref().update(updates)                  -> keys are full paths
//     db.ref('pos/unverified').update(carry)    -> keys are children of that
//
// Getting that wrong would file a write under the wrong path, which is worse than
// not seeing it, so the base is read from the call site rather than assumed.
function updateBags(src) {
  const bags = new Map();   // identifier -> base path ('' means the database root)
  for (const m of src.matchAll(/db\.ref\(\s*(?:(['"`])([^'"`]*)\1)?\s*\)\s*\.update\(\s*(\w+)\s*\)/g)) {
    bags.set(m[3], (m[2] || '').replace(/\/+$/, ''));
  }
  return bags;
}

// The text of `e` when `e` is a single string literal and nothing else, or null.
// skipString finds where the literal ends; if that is not the end of the expression,
// what follows is a concatenation and the whole thing is not a key.
function oneLiteral(e) {
  if (!/^['"`]/.test(e)) return null;
  let end;
  try { end = skipString(e, 0); } catch (err) { return null; }
  return end === e.length ? e.slice(1, -1) : null;
}

// What follows a db.ref('literal' … in the source, as path segments: `$key` for each
// variable, and the text of each literal that comes after one. Stops at the closing
// paren, or at anything it cannot read — a map that guesses is worse than one that
// stops.
function trailingSegments(after) {
  let out = '', i = 0, depth = 0;
  for (;;) {
    const plus = /^\s*\+/.exec(after.slice(i));
    if (!plus) return out;
    i += plus[0].length;

    const lit = /^\s*(['"`])([^'"`]*)\1/.exec(after.slice(i));
    if (lit) {
      i += lit[0].length;
      // Only a literal that STARTS with a slash begins a new segment. Without that,
      // `'orders/history/' + Date.now() + '-' + Math.random()` — one key built out of
      // three pieces — read as a path with a segment called '-' in the middle of it.
      if (lit[2][0] !== '/') return out;              // it continues the current key
      const text = lit[2].replace(/^\/+|\/+$/g, '');
      if (text.includes('${')) return out;            // unresolvable; stop rather than guess
      if (text) out += '/' + text;                    // a bare '/' is a separator, not a segment
      continue;
    }

    // A variable: one segment, then step over the expression to the next + or the
    // end of the call. Doing this with a regex was the bug — it looked for the next
    // literal without first skipping the variable, so every path stopped one level in.
    out += '/$key';
    for (;;) {
      if (i >= after.length) return out;
      const c = after[i];
      if (c === '(' || c === '[') { depth++; i++; continue; }
      if (c === ')' || c === ']') { if (depth === 0) return out; depth--; i++; continue; }
      if (depth === 0 && (c === ',' || c === ';' || c === '\n')) return out;
      if (depth === 0 && c === '+') break;
      i++;
    }
  }
}

function joinPath(base, rest) {
  const r = String(rest).replace(/^\/+|\/+$/g, '');
  if (!base) return r;
  return r ? base + '/' + r : base;
}

function multiPathWrites(src) {
  const bags = updateBags(src);
  if (!bags.size) return [];

  const out = [];
  // The bracket expression, whatever shape it is. Ordinary object writes like
  // byStaff[name] = ... are excluded by the bag check, not by guesswork.
  for (const m of src.matchAll(/(\w+)\s*\[([^\]\n]*)\]\s*=/g)) {
    const [, bag, expr] = m;
    if (!bags.has(bag)) continue;
    const base = bags.get(bag);
    const e = expr.trim();

    // 'a/b/c' or `a/b/${x}` — ONE literal, possibly with a dynamic tail.
    //
    // Testing that with /^(['"`])[\s\S]*\1$/ was wrong: 'a/' + k + '/b' also starts and
    // ends with a quote, so the whole expression was taken as a key and the map grew rows
    // named after their own source text. The string has to end where the expression does.
    const lit = oneLiteral(e);
    if (lit !== null) {
      const key = lit;
      const dyn = key.includes('${');
      const head = (dyn ? key.slice(0, key.indexOf('${')) : key);
      out.push(joinPath(base, head) + (dyn ? '/$key' : ''));
      continue;
    }

    // 'a/b/' + something — the literal head is enough to place it.
    const head = /^(['"`])([^'"`]*)\1\s*\+/.exec(e);
    if (head) { out.push(joinPath(base, head[2]) + '/$key'); continue; }

    // A bare expression under a known base is one child of it: carry[e.payId]
    // under pos/unverified is pos/unverified/$key.
    if (base && !e.includes('+')) { out.push(base + '/$key'); continue; }

    // Anything else — base + '/state', with the prefix in a variable — is left to
    // unresolvedWrites() rather than guessed at.
  }
  return out;
}

// An update can also be handed its object inline, which is the natural shape when
// the keys are fixed:
//
//     db.ref('pos').update({ ledgerEntries: null, bills: null, upiTotal: 0 });
//
// That is the same multi-path write as the bag form above, and just as invisible to
// a scan for db.ref('literal') — the paths are keys, not refs. It reads here as a
// write to `pos`, which is true and useless: what the rules are reviewed against is
// which children it clears.
function inlineUpdateWrites(src) {
  const out = [];
  for (const m of src.matchAll(/db\.ref\(\s*(?:(['"`])([^'"`]*)\1)?\s*\)\s*\.update\(\s*\{/g)) {
    const base = (m[2] || '').replace(/\/+$/, '');
    // db.ref(`orders/active/${station}/${id}`).update({...}) — the same rule the
    // literal scan in derivePaths uses: a template segment is covered by its
    // literal sibling, so placing it under a made-up path would only add noise.
    if (base.includes('${')) continue;
    const open = src.lastIndexOf('{', m.index + m[0].length);
    let body;
    try { body = src.slice(open + 1, matchBraces(src, open) - 1); } catch (e) { continue; }
    for (const key of topLevelKeys(body)) {
      // `orders/active/${station}/${id}/destination` resolves as far as its literal
      // head and no further, exactly as the bag form above does.
      const dyn = key.indexOf('${');
      out.push(joinPath(base, dyn < 0 ? key : key.slice(0, dyn)) + (dyn < 0 ? '' : '/$key'));
    }
  }
  return out;
}

// The keys of one object literal, ignoring anything nested inside a value. A key
// the scan cannot read — a computed one — becomes $key rather than being dropped,
// on the same principle as unresolvedWrites: a map that looks complete and is not
// is worse than one that says where it stops.
function topLevelKeys(body) {
  const keys = [];
  let depth = 0, i = 0, atKey = true;
  while (i < body.length) {
    const c = body[i];
    if (c === '/' && body[i + 1] === '/') { const nl = body.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (c === '/' && body[i + 1] === '*') { const e = body.indexOf('*/', i); if (e < 0) break; i = e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      if (depth === 0 && atKey) {
        const end = skipString(body, i);
        const after = /^\s*:/.test(body.slice(end));
        if (after) { keys.push(body.slice(i + 1, end - 1)); atKey = false; i = end; continue; }
      }
      i = skipString(body, i); continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      if (depth === 0 && atKey && c === '[') { keys.push('$key'); atKey = false; }
      depth++; i++; continue;
    }
    if (c === '}' || c === ']' || c === ')') { depth--; i++; continue; }
    if (depth === 0 && c === ',') { atKey = true; i++; continue; }
    if (depth === 0 && atKey && /[A-Za-z_$]/.test(c)) {
      const w = /^[A-Za-z_$][\w$]*/.exec(body.slice(i))[0];
      if (/^\s*:/.test(body.slice(i + w.length))) { keys.push(w); atKey = false; i += w.length; continue; }
      atKey = false; i += w.length; continue;
    }
    if (depth === 0 && !/\s/.test(c)) atKey = false;
    i++;
  }
  return keys;
}

// The keys the scan above could not place. Reported rather than dropped, so the
// access map can say how much of itself is missing instead of looking complete.
function unresolvedWrites() {
  const out = [];
  for (const [file, role] of Object.entries(APPS)) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const bags = updateBags(src);
    if (!bags.size) continue;
    for (const m of src.matchAll(/(\w+)\s*\[([^\]\n]*)\]\s*=/g)) {
      const [, bag, expr] = m;
      if (!bags.has(bag)) continue;
      const e = expr.trim();
      const base = bags.get(bag);
      if (oneLiteral(e) !== null) continue;                       // literal
      if (/^(['"`])[^'"`]*\1\s*\+/.test(e)) continue;             // literal head
      if (base && !e.includes('+')) continue;                       // one child of a known base
      out.push({ file, role, expr: e });
    }
  }
  return out;
}

// Which paths the Worker touches, and how.
//
// It is not one of the apps, so derivePaths cannot see it — and it is the component
// most likely to have a write nobody reads, because none of it is on a screen. It is
// also the one whose reads fail SILENTLY: monLoad returns null on a denied response,
// so a rule that shuts the robot out turns the hourly report into a quiet nothing.
// Both suites that care read this from here rather than keeping a copy each.
function deriveWorkerPaths() {
  const src = fs.readFileSync(path.join(ROOT, 'worker', 'worker.js'), 'utf8');
  const out = new Map();
  const touch = (p, kind) => {
    const key = p.replace(/^\//, '');
    if (!key) return;                       // the root PATCH, handled below
    const rec = out.get(key) || { read: false, write: false };
    rec[kind] = true;
    out.set(key, rec);
  };
  for (const m of src.matchAll(/DB_URL \+ '([^']+)'/g)) {
    let p = m[1].replace(/\.json.*$/, '');
    p = p.endsWith('/') && p !== '/' ? p + '$key' : p;
    const after = src.slice(m.index, m.index + 260);
    touch(p, /method\s*:\s*'(PUT|PATCH|POST|DELETE)'/.test(after) ? 'write' : 'read');
  }
  // monLoad only ever reads.
  for (const m of src.matchAll(/monLoad\([^,]+,\s*'([^']+)'\)/g)) touch(m[1], 'read');

  // The multi-path writes, which go out as one PATCH at the root and so carry their
  // paths in the object keys rather than in the URL. This used to be a hardcoded
  // `monitor` — true when the monitor was the only handler that wrote that way, and
  // quietly wrong the moment a second one did. Both the cash-out and the stock log
  // write like this now, and neither was visible.
  // One pass: a literal followed by + has a dynamic tail and resolves as far as its
  // head, exactly as the page-side deriver treats the same shape. Two passes over the
  // same matches produced both `inventory/logs/` and `inventory/logs/$key`, and the
  // first of those is not a path.
  for (const m of src.matchAll(/updates\[\s*'([^']*)'/g)) {
    const key = m[1];
    const dyn = key.indexOf('${');
    if (dyn >= 0) { touch('/' + key.slice(0, dyn).replace(/\/+$/, '') + '/$key', 'write'); continue; }
    // Same resolver the page scan uses, so `updates['orders/tableIndex/' + label +
    // '/' + id]` lands two levels down rather than one — which is where its rule is.
    touch('/' + key.replace(/\/+$/, '') + trailingSegments(src.slice(m.index + m[0].length)), 'write');
  }
  return out;
}

function derivePaths() {
  const found = new Map();
  for (const [file, role] of Object.entries(APPS)) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');

    for (const p of multiPathWrites(src).concat(inlineUpdateWrites(src))) {
      if (!found.has(p)) found.set(p, { read: new Set(), write: new Set(), writes: [] });
      found.get(p).write.add(role);
      found.get(p).writes.push({ role, file, snippet: 'multi-path update' });
    }

    const re = /db\.ref\(\s*(['"`])([^'"`]*)\1/g;
    let m;
    while ((m = re.exec(src))) {
      let p = m[2].replace(/\/$/, '');
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
      // A ref is often built from alternating literals and variables:
      //
      //     db.ref('orders/tableIndex/' + label + '/' + trackId)
      //     db.ref('orders/history/' + key + '/voided')
      //
      // Stopping at the first variable called both of those one level deep, and the
      // first is two — so the rules check asked whether a write to the TABLE was
      // permitted when what the app writes is a child of it, and reported a rule as
      // missing that was sitting one level down. Keep consuming the pairs.
      p += trailingSegments(after);
      if (p.startsWith('.info') || !p) continue;      // .info is always readable
      if (p.includes('${')) continue;                 // template segment; its literal sibling covers it
      let kind = null, best = Infinity, op = null;
      for (const [rx, k] of OPS) {
        const i = after.search(rx);
        if (i >= 0 && i < best) { best = i; kind = k; op = rx; }
      }
      if (!kind) continue;
      // push() does not write the node — it writes a generated child of it, and the
      // rules for that live under a $wildcard. So the effective path is one level
      // down; treating it as the node itself reports a rule as missing when it is
      // sitting right there.
      if (op && /push/.test(op.source) && !p.endsWith('/$key')) p += '/$key';
      if (!found.has(p)) found.set(p, { read: new Set(), write: new Set(), writes: [] });
      found.get(p)[kind].add(role);
      if (kind === 'write') found.get(p).writes.push({ role, file, snippet: after.slice(0, 400) });
    }
  }
  return found;
}

module.exports = { ROOT, readPage, deriveWorkerPaths, extractFunction, extractAssignedFunction, buildModule, loadQrEncoder, suite, stripComments, APPS, derivePaths, unresolvedWrites };
