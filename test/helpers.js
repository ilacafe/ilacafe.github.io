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
// template substitutions and comments. Regex literals containing a quote or a
// brace would fool this; none of the extracted functions has one.
function matchBraces(src, openIdx) {
  let depth = 0, i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  throw new Error('unbalanced braces from offset ' + openIdx);
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

// Source text of `function <name>(...) { ... }`, braces balanced.
function extractFunction(src, name) {
  const re = new RegExp('(?:^|\\n)\\s*function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) {
    throw new Error(
      'could not find function ' + name + '() in the page.\n' +
      'It was renamed, moved, or turned into an expression — update the suite ' +
      'that reads it so the tests keep covering the code that actually ships.');
  }
  const start = src.indexOf('function', m.index);
  const open = src.indexOf('{', start);
  return src.slice(start, matchBraces(src, open));
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

function derivePaths() {
  const found = new Map();
  for (const [file, role] of Object.entries(APPS)) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const re = /db\.ref\(\s*(['"`])([^'"`]*)\1/g;
    let m;
    while ((m = re.exec(src))) {
      let p = m[2].replace(/\/$/, '');
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
      if (/^\s*\+/.test(after)) p += '/$key';        // a dynamic child appended to the literal
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

module.exports = { ROOT, readPage, extractFunction, buildModule, loadQrEncoder, suite, APPS, derivePaths };
