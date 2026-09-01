// Café Ila — the payment QR encoder, shared by the till and the customer's phone.
//
// It lived inside pos.html until the customer app needed to draw a code too: the
// ordering page now shows the customer the same UPI code the counter shows, for
// them to scan from a second device. Two copies of an encoder is two encoders to
// keep right, and a wrong QR is worse than a missing one — it scans, and it pays
// the wrong thing or nothing. So there is one, here, loaded by both pages.
//
// test/qr.test.js reads THIS file: every module compared against a reference
// encoder, every code read back out by an independent decoder, and the masking
// penalties scored against the spec.

// ===== QR ENCODER (byte mode, error correction level M) =====
// Here so the café never needs a third party to be reachable in order to take a
// payment. The UPI QR used to be fetched from quickchart.io at the moment of
// payment: if that host was slow, blocked or down, the counter could not be paid.
//
// Byte mode and level M only — that is all a upi:// string needs, and it keeps
// this to the two tables below. Level M is the usual choice for payment codes:
// ~15% recovery, so a thumbprint or a screen glare does not stop a scan.
// Implements ISO/IEC 18004. Versions 1–20 (up to 712 bytes at M) — a upi:// string
// is nearer 60.
(function (root) {
  'use strict';

  // Error-correction codewords per block, and block count, for level M, versions 1–20.
  var ECC_PER_BLOCK = [null, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
  var NUM_BLOCKS    = [null,  1,  1,  1,  2,  2,  4,  4,  4,  5,  5,  5,  8,  9,  9, 10, 10, 11, 13, 14, 16];
  var MAX_VERSION   = 20;
  var PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  // ---- GF(256) arithmetic, primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    var result = new Uint8Array(degree);
    result[degree - 1] = 1;                 // start with the monomial x^0
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var result = new Uint8Array(divisor.length);
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ result[0];
      for (var s = 0; s < result.length - 1; s++) result[s] = result[s + 1];
      result[result.length - 1] = 0;
      for (var i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
    }
    return result;
  }

  // ---- capacity
  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function numDataCodewords(ver) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }
  function alignmentPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function toUtf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {          // surrogate pair
        var lo = str.charCodeAt(i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return out;
  }

  // ---- the encoder proper
  function encode(text) {
    var data = toUtf8(String(text));

    // smallest version that fits, remembering that the character-count field widens at v10
    var ver = 0;
    for (var v = 1; v <= MAX_VERSION; v++) {
      var ccBits = (v < 10) ? 8 : 16;
      if (4 + ccBits + data.length * 8 <= numDataCodewords(v) * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('QR: ' + data.length + ' bytes is too long to encode');

    var capacityBits = numDataCodewords(ver) * 8;
    var bits = [];
    function push(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }

    push(4, 4);                                     // mode indicator: byte
    push(data.length, ver < 10 ? 8 : 16);           // character count
    for (var d = 0; d < data.length; d++) push(data[d], 8);

    push(0, Math.min(4, capacityBits - bits.length));      // terminator
    push(0, (8 - bits.length % 8) % 8);                    // pad to a byte boundary
    for (var pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) push(pad, 8);

    var dataCodewords = new Uint8Array(bits.length / 8);
    for (var i = 0; i < bits.length; i++) dataCodewords[i >>> 3] |= bits[i] << (7 - (i & 7));

    var allCodewords = addEccAndInterleave(dataCodewords, ver);
    return buildMatrix(allCodewords, ver);
  }

  function addEccAndInterleave(data, ver) {
    var numBlocks = NUM_BLOCKS[ver];
    var eccLen = ECC_PER_BLOCK[ver];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;

    var blocks = [], divisor = rsDivisor(eccLen), k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var dataLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
      var dat = Array.prototype.slice.call(data.slice(k, k + dataLen));
      k += dataLen;
      var ecc = rsRemainder(dat, divisor);
      // A short block carries one data codeword fewer than a long one. Padding it with a
      // placeholder keeps every block the same length, so the interleave below can walk them
      // in lockstep and simply skip that one column — without it, the ECC of the short blocks
      // lands one position early and the code is unreadable.
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(Array.prototype.slice.call(ecc)));
    }

    // Interleave: codeword c of every block in turn, skipping the placeholder column.
    var result = [];
    for (var c = 0; c < blocks[0].length; c++) {
      for (var b = 0; b < blocks.length; b++) {
        if (c !== shortBlockLen - eccLen || b >= numShortBlocks) result.push(blocks[b][c]);
      }
    }
    return result;
  }

  function buildMatrix(codewords, ver) {
    var size = ver * 4 + 17;
    var modules = [], isFn = [];
    for (var y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFn.push(new Array(size).fill(false));
    }
    function set(x, y, dark) { modules[y][x] = dark; isFn[y][x] = true; }

    // timing patterns
    for (var i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

    // finder patterns + separators
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    // alignment patterns (never on top of a finder)
    var pos = alignmentPositions(ver), n = pos.length;
    for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
      for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++)
        set(pos[a] + dx2, pos[b] + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
    }

    // reserve the format areas (real bits written after the mask is chosen)
    drawFormat(modules, isFn, size, 0, true);
    // version information, v7+
    if (ver >= 7) {
      var rem = ver;
      for (var t = 0; t < 12; t++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var bitsV = ver << 12 | rem;
      for (var q = 0; q < 18; q++) {
        var dark = ((bitsV >>> q) & 1) !== 0;
        var aa = size - 11 + q % 3, bb = Math.floor(q / 3);
        set(aa, bb, dark); set(bb, aa, dark);
      }
    }

    // ---- data, laid out in the two-module-wide zigzag from the bottom right
    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                            // the vertical timing column is skipped
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x2 = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y2 = upward ? size - 1 - vert : vert;
          if (!isFn[y2][x2] && idx < codewords.length * 8) {
            modules[y2][x2] = ((codewords[idx >>> 3] >>> (7 - (idx & 7))) & 1) !== 0;
            idx++;
          }
          // remainder bits past the data are left light, which is what the spec asks for
        }
      }
    }

    // ---- pick the mask with the lowest penalty
    var bestMask = 0, minPenalty = Infinity, bestModules = null;
    for (var m = 0; m < 8; m++) {
      var trial = modules.map(function (r) { return r.slice(); });
      applyMask(trial, isFn, size, m);
      drawFormat(trial, null, size, m, false);
      var p = penalty(trial, size);
      if (p < minPenalty) { minPenalty = p; bestMask = m; bestModules = trial; }
    }
    return { size: size, version: ver, mask: bestMask, modules: bestModules };
  }

  function maskFn(m, x, y) {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return x * y % 2 + x * y % 3 === 0;
      case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
      case 7: return ((x + y) % 2 + x * y % 3) % 2 === 0;
    }
  }
  function applyMask(modules, isFn, size, m) {
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++)
      if (!isFn[y][x] && maskFn(m, x, y)) modules[y][x] = !modules[y][x];
  }

  // 15-bit BCH format information. `reserve` marks the cells as function modules
  // on the first pass, before a mask has been chosen.
  function drawFormat(modules, isFn, size, mask, reserve) {
    // The two ECC-level bits are 00 for level M (they are NOT the level's ordinal:
    // L=01, M=00, Q=11, H=10), followed by the three mask bits.
    var data = (0 << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    function put(x, y, dark) { modules[y][x] = dark; if (isFn) isFn[y][x] = true; }
    var b = function (i) { return ((bits >>> i) & 1) !== 0; };

    for (var k = 0; k <= 5; k++) put(8, k, b(k));
    put(8, 7, b(6)); put(8, 8, b(7)); put(7, 8, b(8));
    for (var j = 9; j < 15; j++) put(14 - j, 8, b(j));

    for (var q = 0; q < 8; q++) put(size - 1 - q, 8, b(q));
    for (var r = 8; r < 15; r++) put(8, size - 15 + r, b(r));
    put(8, size - 8, true);                            // always-dark module
    if (reserve) { /* cells are now marked as function modules */ }
  }

  function penalty(modules, size) {
    var result = 0, x, y;
    function mod(x, y) { return modules[y][x]; }

    function addHistory(run, hist) {
      if (hist[0] === 0) run += size;                  // light border before the first run
      hist.pop(); hist.unshift(run);
    }
    function countPatterns(hist) {
      var n = hist[1];
      var core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
      return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0)
           + (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
    }
    function terminate(runColor, runLen, hist) {
      if (runColor) { addHistory(runLen, hist); runLen = 0; }
      runLen += size;                                  // light border after the last run
      addHistory(runLen, hist);
      return countPatterns(hist);
    }

    for (y = 0; y < size; y++) {
      var runColor = false, runLen = 0, hist = [0, 0, 0, 0, 0, 0, 0];
      for (x = 0; x < size; x++) {
        if (mod(x, y) === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1; else if (runLen > 5) result++;
        } else {
          addHistory(runLen, hist);
          if (!runColor) result += countPatterns(hist) * PENALTY_N3;
          runColor = mod(x, y); runLen = 1;
        }
      }
      result += terminate(runColor, runLen, hist) * PENALTY_N3;
    }
    for (x = 0; x < size; x++) {
      var runColorC = false, runLenC = 0, histC = [0, 0, 0, 0, 0, 0, 0];
      for (y = 0; y < size; y++) {
        if (mod(x, y) === runColorC) {
          runLenC++;
          if (runLenC === 5) result += PENALTY_N1; else if (runLenC > 5) result++;
        } else {
          addHistory(runLenC, histC);
          if (!runColorC) result += countPatterns(histC) * PENALTY_N3;
          runColorC = mod(x, y); runLenC = 1;
        }
      }
      result += terminate(runColorC, runLenC, histC) * PENALTY_N3;
    }
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
      var c = mod(x, y);
      if (c === mod(x + 1, y) && c === mod(x, y + 1) && c === mod(x + 1, y + 1)) result += PENALTY_N2;
    }
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (mod(x, y)) dark++;
    var total = size * size;
    var k2 = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k2 * PENALTY_N4;
  }

  // ---- render
  // Drawn at an integer scale so every module is the same number of device pixels:
  // a fractional scale blurs the edges and phones hunt for focus on it.
  function drawToCanvas(canvas, text, cssSize, quiet) {
    var qr = encode(text);
    var q = (quiet == null) ? 4 : quiet;                       // spec asks for 4 modules of quiet zone
    var totalModules = qr.size + q * 2;
    var dpr = (root.devicePixelRatio || 1);
    var scale = Math.max(1, Math.floor((cssSize * dpr) / totalModules));
    var px = totalModules * scale;

    canvas.width = px; canvas.height = px;
    canvas.style.width = cssSize + 'px';
    canvas.style.height = cssSize + 'px';

    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000000';
    for (var y = 0; y < qr.size; y++) for (var x = 0; x < qr.size; x++)
      if (qr.modules[y][x]) ctx.fillRect((x + q) * scale, (y + q) * scale, scale, scale);
    return qr;
  }

  var API = { encode: encode, drawToCanvas: drawToCanvas };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.ilaQR = API;
})(typeof window !== 'undefined' ? window : globalThis);
