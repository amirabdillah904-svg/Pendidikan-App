/**
 * Self-contained Offline ISO/IEC 18004 QR Code Generator (Versions 1-10, EC Level M, Byte Mode)
 * Zero external dependencies — works 100% offline in Android WebView & PWA.
 */
(function (global) {
  'use strict';

  // GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGalois() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsGeneratorPoly(ecCount) {
    let poly = [1];
    for (let i = 0; i < ecCount; i++) {
      const next = new Array(poly.length + 1).fill(0);
      const factor = EXP[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], factor);
      }
      poly = next;
    }
    return poly;
  }

  function rsComputeRemainder(data, ecCount) {
    const gen = rsGeneratorPoly(ecCount);
    const res = new Uint8Array(ecCount);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ res[0];
      for (let j = 0; j < ecCount - 1; j++) res[j] = res[j + 1];
      res[ecCount - 1] = 0;
      if (factor !== 0) {
        for (let j = 0; j < ecCount; j++) {
          res[j] ^= gfMul(gen[j + 1], factor);
        }
      }
    }
    return res;
  }

  // ISO/IEC 18004 EC Level M parameters for Versions 1..10
  // Format: [version, totalDataCodewords, ecPerBlock, [[numBlocks, dataPerBlock], ...]]
  const VERSION_SPECS_M = [
    null,
    { v: 1, dataCap: 16, ecPerBlock: 10, groups: [[1, 16]] },
    { v: 2, dataCap: 28, ecPerBlock: 16, groups: [[1, 28]] },
    { v: 3, dataCap: 44, ecPerBlock: 26, groups: [[1, 44]] },
    { v: 4, dataCap: 64, ecPerBlock: 18, groups: [[2, 32]] },
    { v: 5, dataCap: 86, ecPerBlock: 24, groups: [[2, 43]] },
    { v: 6, dataCap: 108, ecPerBlock: 16, groups: [[4, 27]] },
    { v: 7, dataCap: 124, ecPerBlock: 18, groups: [[4, 31]] },
    { v: 8, dataCap: 154, ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
    { v: 9, dataCap: 182, ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
    { v: 10, dataCap: 216, ecPerBlock: 26, groups: [[4, 43], [1, 44]] }
  ];

  const ALIGN_POS = [
    [],
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50]
  ];

  function toUtf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') {
      return Array.from(new TextEncoder().encode(String(str || '')));
    }
    const out = [];
    const s = unescape(encodeURIComponent(String(str || '')));
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function bchFormatInfo(ecBits, mask) {
    const data = ((ecBits & 3) << 3) | (mask & 7);
    let rem = data << 10;
    for (let i = 4; i >= 0; i--) {
      if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
    }
    return ((data << 10) | rem) ^ 0x5412;
  }

  function bchVersionInfo(version) {
    let rem = version << 12;
    for (let i = 5; i >= 0; i--) {
      if (rem & (1 << (i + 12))) rem ^= 0x1f25 << i;
    }
    return (version << 12) | rem;
  }

  function buildDataCodewords(bytes, spec) {
    const countBits = spec.v <= 9 ? 8 : 16;
    const bits = [];
    function pushBits(val, len) {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }

    // Mode indicator: Byte (0100)
    pushBits(0x4, 4);
    pushBits(bytes.length, countBits);
    for (let i = 0; i < bytes.length; i++) pushBits(bytes[i], 8);

    const maxBits = spec.dataCap * 8;
    const termLen = Math.min(4, maxBits - bits.length);
    pushBits(0, termLen);
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      codewords.push(b);
    }

    const padBytes = [0xec, 0x11];
    let p = 0;
    while (codewords.length < spec.dataCap) {
      codewords.push(padBytes[p & 1]);
      p++;
    }
    return codewords;
  }

  function interleaveBlocks(dataCodewords, spec) {
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (let g = 0; g < spec.groups.length; g++) {
      const numBlocks = spec.groups[g][0];
      const dataLen = spec.groups[g][1];
      for (let b = 0; b < numBlocks; b++) {
        const block = dataCodewords.slice(offset, offset + dataLen);
        offset += dataLen;
        dataBlocks.push(block);
        ecBlocks.push(rsComputeRemainder(block, spec.ecPerBlock));
      }
    }

    const result = [];
    const maxDataLen = Math.max.apply(null, dataBlocks.map(b => b.length));
    for (let i = 0; i < maxDataLen; i++) {
      for (let b = 0; b < dataBlocks.length; b++) {
        if (i < dataBlocks[b].length) result.push(dataBlocks[b][i]);
      }
    }
    for (let i = 0; i < spec.ecPerBlock; i++) {
      for (let b = 0; b < ecBlocks.length; b++) {
        result.push(ecBlocks[b][i]);
      }
    }
    return result;
  }

  function createMatrix(version) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Uint8Array(size));
    const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

    function setFunc(r, c, dark) {
      if (r < 0 || r >= size || c < 0 || c >= size) return;
      modules[r][c] = dark ? 1 : 0;
      isFunc[r][c] = 1;
    }

    // Finder patterns + separators
    function drawFinder(top, left) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = top + dr;
          const c = left + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const dark =
            inOuter &&
            (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
          setFunc(r, c, dark);
        }
      }
    }
    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Alignment patterns
    const coords = ALIGN_POS[version] || [];
    for (let i = 0; i < coords.length; i++) {
      for (let j = 0; j < coords.length; j++) {
        const cr = coords[i];
        const cc = coords[j];
        if (isFunc[cr][cc]) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFunc(cr + dr, cc + dc, dark);
          }
        }
      }
    }

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      if (!isFunc[6][i]) setFunc(6, i, (i & 1) === 0);
      if (!isFunc[i][6]) setFunc(i, 6, (i & 1) === 0);
    }

    // Dark module
    setFunc(size - 8, 8, true);

    // Reserve format info areas
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        isFunc[8][i] = 1;
        isFunc[i][8] = 1;
      }
    }
    for (let i = size - 8; i < size; i++) {
      isFunc[8][i] = 1;
      isFunc[i][8] = 1;
    }

    // Version info for v >= 7
    if (version >= 7) {
      const vBits = bchVersionInfo(version);
      for (let i = 0; i < 18; i++) {
        const dark = ((vBits >>> i) & 1) === 1;
        const a = Math.floor(i / 3);
        const b = size - 11 + (i % 3);
        setFunc(a, b, dark);
        setFunc(b, a, dark);
      }
    }

    return { size, modules, isFunc };
  }

  function placeDataBits(matrix, allCodewords) {
    const { size, modules, isFunc } = matrix;
    let bitIdx = 0;
    const totalBits = allCodewords.length * 8;
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        const r = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          if (!isFunc[r][c]) {
            let dark = 0;
            if (bitIdx < totalBits) {
              dark = (allCodewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
              bitIdx++;
            }
            modules[r][c] = dark;
          }
        }
      }
      upward = !upward;
    }
  }

  function applyMaskAndFormat(baseMatrix, mask) {
    const size = baseMatrix.size;
    const modules = baseMatrix.modules.map(row => new Uint8Array(row));
    const isFunc = baseMatrix.isFunc;

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (isFunc[r][c]) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (r + c) % 2 === 0; break;
          case 1: invert = r % 2 === 0; break;
          case 2: invert = c % 3 === 0; break;
          case 3: invert = (r + c) % 3 === 0; break;
          case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
          case 5: invert = ((r * c) % 2) + ((r * c) % 3) === 0; break;
          case 6: invert = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
          case 7: invert = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break;
        }
        if (invert) modules[r][c] ^= 1;
      }
    }

    // Format info for EC Level M (ecBits = 0)
    const fmt = bchFormatInfo(0, mask);
    for (let i = 0; i <= 5; i++) modules[8][i] = (fmt >>> (14 - i)) & 1;
    modules[8][7] = (fmt >>> 8) & 1;
    modules[8][8] = (fmt >>> 7) & 1;
    modules[7][8] = (fmt >>> 6) & 1;
    for (let i = 9; i < 15; i++) modules[14 - i][8] = (fmt >>> (14 - i)) & 1;

    for (let i = 0; i < 8; i++) modules[size - 1 - i][8] = (fmt >>> i) & 1;
    for (let i = 8; i < 15; i++) modules[8][size - 15 + i] = (fmt >>> i) & 1;

    return { size, modules };
  }

  function evaluatePenalty(qr) {
    const { size, modules } = qr;
    let penalty = 0;

    // Rule 1: adjacent modules in row/col
    for (let r = 0; r < size; r++) {
      let runColor = modules[r][0], runLen = 1;
      for (let c = 1; c < size; c++) {
        if (modules[r][c] === runColor) {
          runLen++;
          if (runLen === 5) penalty += 3;
          else if (runLen > 5) penalty += 1;
        } else {
          runColor = modules[r][c];
          runLen = 1;
        }
      }
    }
    for (let c = 0; c < size; c++) {
      let runColor = modules[0][c], runLen = 1;
      for (let r = 1; r < size; r++) {
        if (modules[r][c] === runColor) {
          runLen++;
          if (runLen === 5) penalty += 3;
          else if (runLen > 5) penalty += 1;
        } else {
          runColor = modules[r][c];
          runLen = 1;
        }
      }
    }

    // Rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = modules[r][c];
        if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
          penalty += 3;
        }
      }
    }

    // Rule 4: dark ratio balance
    let darkCount = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) darkCount += modules[r][c];
    }
    const pct = (darkCount * 100) / (size * size);
    const diff = Math.floor(Math.abs(pct - 50) / 5);
    penalty += diff * 10;

    return penalty;
  }

  function encode(text) {
    const bytes = toUtf8Bytes(text);
    let spec = null;
    for (let v = 1; v <= 10; v++) {
      const s = VERSION_SPECS_M[v];
      const headerBytes = v <= 9 ? 2 : 3;
      if (bytes.length + headerBytes <= s.dataCap) {
        spec = s;
        break;
      }
    }
    if (!spec) {
      throw new Error('Teks terlalu panjang untuk QR Code (maks 213 byte).');
    }

    const dataCw = buildDataCodewords(bytes, spec);
    const fullCw = interleaveBlocks(dataCw, spec);
    const base = createMatrix(spec.v);
    placeDataBits(base, fullCw);

    let bestQr = null;
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      const candidate = applyMaskAndFormat(base, m);
      const score = evaluatePenalty(candidate);
      if (score < bestScore) {
        bestScore = score;
        bestQr = candidate;
      }
    }
    return bestQr;
  }

  function drawToCanvas(canvas, text, options) {
    const opts = options || {};
    const pixelSize = opts.size || 320;
    const quietZone = typeof opts.margin === 'number' ? opts.margin : 4;
    const fg = opts.fg || '#0F172A';
    const bg = opts.bg || '#FFFFFF';

    const qr = encode(text);
    const totalModules = qr.size + quietZone * 2;
    const scale = Math.max(1, Math.floor(pixelSize / totalModules));
    const drawDim = totalModules * scale;
    const pad = Math.floor((pixelSize - drawDim) / 2);

    canvas.width = pixelSize;
    canvas.height = pixelSize;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, pixelSize, pixelSize);
    ctx.fillStyle = fg;

    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) {
          ctx.fillRect(pad + (c + quietZone) * scale, pad + (r + quietZone) * scale, scale, scale);
        }
      }
    }
    return qr;
  }

  function toDataUrl(text, options) {
    const canvas = document.createElement('canvas');
    drawToCanvas(canvas, text, options);
    return canvas.toDataURL('image/png');
  }

  global.AlRifaieQrLib = {
    encode: encode,
    drawToCanvas: drawToCanvas,
    toDataUrl: toDataUrl
  };
})(window);
