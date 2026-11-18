(function() {
function readWordBigInt(byteArray, relOffset, size, endian) {
  let val = 0n;
  for (let i = 0; i < size; i++) {
    const idx = relOffset + i;
    const b = BigInt(idx >= 0 && idx < byteArray.length ? byteArray[idx] : 0);
    val = endian === 'big' ? (val << 8n) | b : val | (b << BigInt(i * 8));
  }
  return val;
}

function extractBitfield(regValBig, msb, lsb) {
  const width = BigInt(msb - lsb + 1);
  return (regValBig >> BigInt(lsb)) & ((1n << width) - 1n);
}

function replaceBitfield(regValBig, msb, lsb, newFieldValBig) {
  const width = BigInt(msb - lsb + 1);
  const fieldMask = (1n << width) - 1n;
  return (regValBig & ~(fieldMask << BigInt(lsb))) | ((newFieldValBig & fieldMask) << BigInt(lsb));
}

function toSignedBigInt(uValBig, bitWidth) {
  if (bitWidth <= 0) return 0n;
  const signBit = 1n << BigInt(bitWidth - 1);
  return (uValBig & signBit) !== 0n ? uValBig - (1n << BigInt(bitWidth)) : uValBig;
}

function decodeFloatFromBits(uValBig, bitWidth) {
  if (bitWidth === 32) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, Number(uValBig & 0xffffffffn), true);
    const f = dv.getFloat32(0, true);
    return Number.isFinite(f) ? Number(f.toPrecision(7)).toString() : String(f);
  }
  if (bitWidth === 64) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setBigUint64(0, uValBig, true);
    const d = dv.getFloat64(0, true);
    return Number.isFinite(d) ? Number(d.toPrecision(10)).toString() : String(d);
  }
  if (bitWidth === 16) {
    const h = Number(uValBig & 0xffffn);
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return ((s ? -1 : 1) * Math.pow(2, -14) * (f / 1024)).toPrecision(4);
    if (e === 0x1f) return f ? 'NaN' : s ? '-Infinity' : 'Infinity';
    return ((s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024)).toPrecision(5);
  }
  return null;
}

function decodeAsciiFromBits(uValBig, bitWidth, endian) {
  const byteCount = Math.ceil(bitWidth / 8);
  const chars = [];
  for (let i = 0; i < byteCount; i++) {
    const b = Number((uValBig >> BigInt(i * 8)) & 0xffn);
    chars.push(b >= 32 && b <= 126 ? String.fromCharCode(b) : '.');
  }
  if (endian === 'big') chars.reverse();
  return `"${chars.join('')}"`;
}

/**
 * CSP-safe arithmetic & bitwise expression evaluator for variable `x`.
 * Supports +, -, *, /, %, <<, >>, &, ^, |, unary +/-/~, parentheses, and hex/decimal literals.
 */
function evalFieldExpr(exprStr, xNum) {
  const src = String(exprStr || '').trim();
  if (!src) return {ok: true, value: null};
  if (!Number.isFinite(xNum)) return {ok: false, error: 'Non-numeric value'};

  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<<' || two === '>>') {
      tokens.push({t: 'op', v: two});
      i += 2;
      continue;
    }
    if ('+-*/%&^|()~'.includes(ch)) {
      tokens.push({t: ch === '(' || ch === ')' ? ch : 'op', v: ch});
      i++;
      continue;
    }
    if (ch === 'x' || ch === 'X') {
      if (i + 1 < src.length && /[a-zA-Z0-9_]/.test(src[i + 1])) return {ok: false, error: 'Unknown identifier'};
      tokens.push({t: 'num', v: xNum});
      i++;
      continue;
    }
    const numMatch = src.slice(i).match(/^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?|\.\d+)/);
    if (numMatch) {
      const raw = numMatch[0];
      const val = raw.toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseFloat(raw);
      tokens.push({t: 'num', v: val});
      i += raw.length;
      continue;
    }
    return {ok: false, error: `Unexpected "${ch}"`};
  }

  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];

  function parseOr() {
    let left = parseXor();
    while (peek()?.t === 'op' && peek().v === '|') {
      eat();
      left = (left | parseXor()) >>> 0;
    }
    return left;
  }
  function parseXor() {
    let left = parseAnd();
    while (peek()?.t === 'op' && peek().v === '^') {
      eat();
      left = (left ^ parseAnd()) >>> 0;
    }
    return left;
  }
  function parseAnd() {
    let left = parseShift();
    while (peek()?.t === 'op' && peek().v === '&') {
      eat();
      left = (left & parseShift()) >>> 0;
    }
    return left;
  }
  function parseShift() {
    let left = parseAdd();
    while (peek()?.t === 'op' && (peek().v === '<<' || peek().v === '>>')) {
      const op = eat().v;
      const right = parseAdd();
      left = op === '<<' ? (left << right) : (left >> right);
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = eat().v;
      const right = parseMul();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/' || peek().v === '%')) {
      const op = eat().v;
      const right = parseUnary();
      if ((op === '/' || op === '%') && right === 0) throw new Error('Div by 0');
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  }
  function parseUnary() {
    if (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-' || peek().v === '~')) {
      const op = eat().v;
      const v = parseUnary();
      return op === '+' ? +v : op === '-' ? -v : ~v;
    }
    if (peek()?.t === '(') {
      eat();
      const v = parseOr();
      if (peek()?.t !== ')') throw new Error('Missing )');
      eat();
      return v;
    }
    if (peek()?.t === 'num') return eat().v;
    throw new Error('Syntax error');
  }

  try {
    if (tokens.length === 0) return {ok: true, value: null};
    const val = parseOr();
    if (pos < tokens.length) return {ok: false, error: 'Trailing tokens'};
    if (!Number.isFinite(val)) return {ok: false, error: 'Invalid result'};
    return {ok: true, value: Number.isInteger(val) ? val : Number(val.toPrecision(8))};
  } catch (err) {
    return {ok: false, error: err.message};
  }
}

function computeFieldRepresentations(uValBig, bf, endian) {
  const width = bf.msb - bf.lsb + 1;
  const hexStr = '0x' + uValBig.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0');
  const uintStr = uValBig.toString(10);
  const sValBig = toSignedBigInt(uValBig, width);
  const intStr = sValBig.toString(10);
  const binStr = '0b' + uValBig.toString(2).padStart(width, '0');
  const fltRaw = decodeFloatFromBits(uValBig, width);

  let enumName = null;
  if (bf.enums && Object.prototype.hasOwnProperty.call(bf.enums, Number(uValBig))) {
    enumName = bf.enums[Number(uValBig)];
  }

  let engineeredStr = null;
  const unitSuffix = bf.unit ? ` ${bf.unit}` : '';
  if (bf.type === 'float' && fltRaw !== null) engineeredStr = `${fltRaw}${unitSuffix}`;

  if (!engineeredStr && bf.qFormat) {
    const m = bf.qFormat.match(/^(U?)Q(\d+)\.(\d+)$/i);
    if (m) {
      const rawNum = m[1].toUpperCase() === 'U' ? Number(uValBig) : Number(sValBig);
      engineeredStr = `${Number((rawNum / Math.pow(2, parseInt(m[3], 10))).toFixed(6))} (${bf.qFormat}${unitSuffix})`;
    }
  }

  if (!engineeredStr && bf.formula) {
    const baseNum = bf.type === 'int' ? Number(sValBig) :
        bf.type === 'float' && fltRaw !== null ? parseFloat(fltRaw) :
                                                 Number(uValBig);
    const exprRes = evalFieldExpr(bf.formula, baseNum);
    if (exprRes.ok && exprRes.value !== null) {
      engineeredStr = `${exprRes.value}${unitSuffix}`;
    }
  }

  if (!engineeredStr && bf.scale !== null && bf.scale !== undefined) {
    const baseNum = bf.type === 'int' ? Number(sValBig) : Number(uValBig);
    engineeredStr = `${Number((baseNum * Number(bf.scale) + Number(bf.valueOffset || 0)).toFixed(4))}${unitSuffix}`;
  }

  if (!engineeredStr && bf.type === 'ascii') engineeredStr = decodeAsciiFromBits(uValBig, width, endian);
  if (!engineeredStr && bf.unit && bf.scale === null) {
    engineeredStr = `${bf.type === 'int' ? intStr : uintStr}${unitSuffix}`;
  }

  return {hexStr, uintStr, intStr, binStr, fltRaw, enumName, engineeredStr};
}

function decodeEntryFieldValue(byteArr, field, endian) {
  const size = field.size || 4;
  const effEndian = field.endianness || endian;
  if (field.type === 'ascii') {
    const slice = byteArr.slice(field.offset, field.offset + size);
    return {
      hex: '0x' + slice.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(''),
      decoded: '"' + slice.map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('') + '"'
    };
  }
  if (size <= 8) {
    const valBig = readWordBigInt(byteArr, field.offset, size, effEndian);
    const rep = computeFieldRepresentations(valBig, {...field, msb: size * 8 - 1, lsb: 0}, effEndian);
    const primary = field.type === 'bin' ? rep.binStr :
        rep.enumName || rep.engineeredStr ||
        (field.type === 'int'      ? rep.intStr :
             field.type === 'uint' ? rep.uintStr :
                                     rep.hexStr);
    return {hex: rep.hexStr, decoded: primary};
  }
  const slice = byteArr.slice(field.offset, field.offset + Math.min(size, 8));
  return {
    hex: slice.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') + (size > 8 ? ' ...' : ''),
    decoded: `${size} bytes`
  };
}

window.BinsightMath = {
  readWordBigInt,
  extractBitfield,
  replaceBitfield,
  toSignedBigInt,
  decodeFloatFromBits,
  decodeAsciiFromBits,
  evalFieldExpr,
  computeFieldRepresentations,
  decodeEntryFieldValue
};
})();
