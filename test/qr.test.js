// The payment QR is generated in pos.html rather than fetched, so an outage at
// a third party can no longer stop the café taking money. That means the
// encoder is ours to get right, and a wrong QR is worse than a missing one: it
// scans, and it pays the wrong thing or nothing.
//
// Checked three ways, because any one alone is weak:
//   A. every module matches a reference encoder at the same mask — pins the bit
//      stream, the Reed-Solomon ECC, block interleaving, placement, format bits
//   B. an independent DECODER reads the exact string back out of the codes we
//      actually emit, mask and all
//   C. the four masking penalty rules score hand-computed matrices exactly
//
// A alone could share a bug with the reference. B alone would pass on a
// differently-masked but still-valid code. C is checked against the spec rather
// than another implementation.

const { readPage, extractFunction, loadQrEncoder, suite } = require('./helpers');
const QRCode = require('qrcode');
const jsQR = require('jsqr').default || require('jsqr');

const qr = loadQrEncoder();
const qrForced = loadQrEncoder({ forceableMask: true });

// ---------------------------------------------------------------- corpus
const cases = [
  'upi://pay?pa=ilacafe@okhdfcbank&pn=ILA&am=250&cu=INR',
  'upi://pay?pa=ilacafe@okhdfcbank&pn=ILA&am=1250.5&cu=INR',
  'upi://pay?pa=ilacafe@okhdfcbank&pn=ILA&am=0&cu=INR',
  'upi://pay?pa=ila.cafe.blr.outlet01@okaxis&pn=ILA&am=12480.75&cu=INR',
  'upi://pay?pa=q629471833@ybl&pn=ILA&am=99999.99&cu=INR',
  'upi://pay?pa=a@b&pn=I&am=1&cu=INR',
  'A', '0',
  'x'.repeat(100), 'x'.repeat(300), 'x'.repeat(700),
  'Ünïcodë café ☕ ₹250',
  '~!@#$%^&*()_+-=[]{}|;:\'",.<>/?`',
];
const vpas = ['ilacafe@okhdfcbank', 'ila@ybl', 'cafe.ila.blr@okaxis', 'ilacafe.online@paytm'];
for (let i = 0; i < 120; i++) {
  cases.push(`upi://pay?pa=${vpas[i % vpas.length]}&pn=ILA&am=${(Math.random() * 20000).toFixed(i % 3)}&cu=INR`);
}
// every byte length in range, which walks every version and block-layout boundary
for (let n = 1; n <= 320; n++) cases.push('u'.repeat(n));

const { check, note, done } = suite('QR encoder');

// ---------------------------------------------------------------- A
{
  let bad = 0, compared = 0, maskSame = 0;
  const versions = new Set();
  for (const text of cases) {
    // byte mode forced: the reference optimises across numeric/alphanumeric
    // segments, ours is byte-only, so anything else compares two different plans
    const ref = QRCode.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: 'M' });
    if (ref.version > 20) continue;                     // past what we claim to support
    const got = qrForced.encode(text, ref.maskPattern);
    compared++; versions.add(ref.version);
    let ok = got.size === ref.modules.size;
    if (ok) for (let y = 0; y < got.size && ok; y++)
      for (let x = 0; x < got.size && ok; x++)
        if (!!ref.modules.get(y, x) !== !!got.modules[y][x]) ok = false;
    if (!ok) { bad++; if (bad < 3) console.log('    mismatch at v' + ref.version + ', len ' + text.length); }
    if (qr.encode(text).mask === ref.maskPattern) maskSame++;
  }
  check(compared + ' matrices identical to the reference at the same mask', bad === 0, bad + ' differed');
  const vs = [...versions].sort((a, b) => a - b);
  note('versions ' + vs[0] + '–' + vs[vs.length - 1] + ' (' + vs.length + ' distinct)');
  note('mask choice agrees on ' + maskSame + '/' + compared + '; where it differs both are valid — ' +
       'the mask is recorded in the format bits, and B covers the codes we emit');
}

// ---------------------------------------------------------------- B
function render(code, scale, quiet) {
  const total = code.size + quiet * 2, px = total * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) {
    if (!code.modules[y][x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const p = ((y + quiet) * scale + dy) * px + ((x + quiet) * scale + dx);
      data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = 0;
    }
  }
  return { data, width: px, height: px };
}
{
  let bad = 0, done_ = 0;
  for (const text of cases) {
    let code;
    try { code = qr.encode(text); } catch (e) { continue; }
    const img = render(code, 4, 4);
    const out = jsQR(img.data, img.width, img.height);
    done_++;
    if (!out || out.data !== text) {
      bad++;
      if (bad < 3) console.log('    no round-trip: len ' + text.length + ' v' + code.version + ' mask' + code.mask);
    }
  }
  check(done_ + ' codes decoded back to the exact input', bad === 0, bad + ' failed');
}
{
  // level M claims ~15% recovery: a thumb on the screen must not stop a scan
  const payload = 'upi://pay?pa=ilacafe@okhdfcbank&pn=ILA&am=1250.5&cu=INR';
  const code = qr.encode(payload);
  const damaged = { size: code.size, modules: code.modules.map(r => r.slice()) };
  const c = Math.floor(code.size / 2);
  for (let y = c - 2; y <= c + 2; y++) for (let x = c - 2; x <= c + 2; x++) damaged.modules[y][x] = false;
  const img = render(damaged, 4, 4);
  const out = jsQR(img.data, img.width, img.height);
  check('still decodes with a 5×5 block destroyed', !!out && out.data === payload);
}

// ---------------------------------------------------------------- C
{
  const body = extractFunction(readPage('qr.js'), 'penalty');
  // The four rule weights are injected so a single rule can be isolated by
  // zeroing the others' contribution and taking the difference.
  const build = (n1, n2, n3, n4) =>
    new Function('PENALTY_N1', 'PENALTY_N2', 'PENALTY_N3', 'PENALTY_N4', 'Math',
      body + '\nreturn penalty;')(n1, n2, n3, n4, Math);
  const P = build(3, 3, 40, 10);
  const S = 21;
  const light = Array.from({ length: S }, () => new Array(S).fill(false));
  const dark = Array.from({ length: S }, () => new Array(S).fill(true));

  // a uniform 21×21 grid, worked out by hand:
  //   rule 1  each of 42 lines is one run of 21 → 3 + (21−5) = 19  →  798
  //   rule 2  20² same-colour 2×2 blocks × 3                       → 1200
  //   rule 3  no 1:1:3:1:1 signature exists                        →    0
  //   rule 4  ratio 0% or 100% → (ceil(4410/441) − 1) × 10         →   90
  check('all-light 21×21 scores 2088', P(light, S) === 2088, String(P(light, S)));
  check('all-dark 21×21 scores 2088', P(dark, S) === 2088, String(P(dark, S)));

  // rule 3 in isolation: vary only its weight, so the other three cancel out
  const withPattern = light.map(r => r.slice());
  [4, 6, 7, 8, 10].forEach(x => { withPattern[10][x] = true; });   // ....#.###.#....
  check('rule 3 finds the 1:1:3:1:1 signature in both directions',
        P(withPattern, S) - build(3, 3, 0, 10)(withPattern, S) === 80);

  const plainRun = light.map(r => r.slice());
  [4, 5, 6].forEach(x => { plainRun[10][x] = true; });
  check('rule 3 stays silent on a plain run',
        P(plainRun, S) - build(3, 3, 0, 10)(plainRun, S) === 0);

  const run = len => { const g = light.map(r => r.slice()); for (let x = 0; x < len; x++) g[10][x] = true; return P(g, S); };
  check('rule 1 first scores at a run of 5, then one per extra module',
        run(5) - run(6) === 9 && run(4) > run(5), [run(4), run(5), run(6)].join(' '));
}

// ---------------------------------------------------------------- D
{
  const code = qr.encode('upi://pay?pa=ilacafe@okhdfcbank&pn=ILA&am=250&cu=INR');
  const m = code.modules, S = code.size;
  check('size is 4·version + 17', S === code.version * 4 + 17);
  const finderOK = (cx, cy) => {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++)
      if (m[cy + dy][cx + dx] !== (Math.max(Math.abs(dx), Math.abs(dy)) !== 2)) return false;
    return true;
  };
  check('all three finder patterns are correct', finderOK(3, 3) && finderOK(S - 4, 3) && finderOK(3, S - 4));
  let timing = true;
  for (let i = 8; i < S - 8; i++) if (m[6][i] !== (i % 2 === 0) || m[i][6] !== (i % 2 === 0)) timing = false;
  check('timing patterns alternate', timing);
  check('the always-dark module is dark', m[S - 8][8] === true);
  let d = 0; for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (m[y][x]) d++;
  check('dark ratio is between 0.35 and 0.65', d / (S * S) > 0.35 && d / (S * S) < 0.65,
        (d / (S * S)).toFixed(3));
}
{
  const a = qr.encode('upi://pay?pa=x@y&pn=ILA&am=250&cu=INR');
  const b = qr.encode('upi://pay?pa=x@y&pn=ILA&am=260&cu=INR');
  let diff = 0;
  for (let y = 0; y < a.size; y++) for (let x = 0; x < a.size; x++) if (a.modules[y][x] !== b.modules[y][x]) diff++;
  check('a ₹10 change alters the code substantially', diff > 40, diff + ' modules');
}
{
  let threw = false;
  try { qr.encode('x'.repeat(2000)); } catch (e) { threw = /too long/.test(e.message); }
  check('over-long input throws rather than emitting a bad code', threw);
  check('an empty string still yields a valid v1 code', qr.encode('').size === 21);
}
{
  const t0 = Date.now();
  for (let i = 0; i < 300; i++) qr.encode('upi://pay?pa=ilacafe@okhdfcbank&pn=ILA&am=' + (100 + i) + '&cu=INR');
  const ms = (Date.now() - t0) / 300;
  check('encodes in well under one frame', ms < 16, ms.toFixed(2) + 'ms');
  note(ms.toFixed(2) + 'ms per code');
}

done();
