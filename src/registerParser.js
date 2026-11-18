/**
 * Canonical *.binsight.json Schema & *.binsight-layout.json Profile Parser (v2.0)
 * Supports 4 Schema Inspection Modes:
 *  1. "struct-view"      : Fixed struct / header parsed as a clean tabular list
 *  2. "record-trace"     : Paged repeated entries (e.g. 72B entries in 8KB blocks with padding & polymorphic types)
 *  3. "protocol-analyze" : Communication packet stream + 32-bit-wide Spec Diagram (e.g. UFS UPIU)
 *  4. "registers"        : Multi-segment hardware register map with bitfields & editing
 */

const fs = require('fs');
const path = require('path');

function parseNumber(val, fallback = 0) {
  if (typeof val === 'number' && !Number.isNaN(val)) return val;
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s) return fallback;
    const n = s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

function parseBitRange(bitsSpec) {
  if (typeof bitsSpec === 'number') {
    return {msb: bitsSpec, lsb: bitsSpec};
  }
  const str = String(bitsSpec ?? '0').trim().replace(/^\[|\]$/g, '');
  if (str.includes(':')) {
    const [p1, p2] = str.split(':').map((s) => parseInt(s.trim(), 10));
    if (Number.isNaN(p1) || Number.isNaN(p2)) {
      throw new Error(`Invalid bit range "${bitsSpec}".`);
    }
    return {msb: Math.max(p1, p2), lsb: Math.min(p1, p2)};
  }
  const bit = parseInt(str, 10);
  if (Number.isNaN(bit)) {
    throw new Error(`Invalid bit specification "${bitsSpec}".`);
  }
  return {msb: bit, lsb: bit};
}

function normalizeBitField(f) {
  const {msb, lsb} = parseBitRange(f.bits ?? `${f.msb ?? 0}:${f.lsb ?? 0}`);
  const fname = String(f.name || `BIT_${msb}_${lsb}`);
  return {
    name: fname,
    bits: `${msb}:${lsb}`,
    msb,
    lsb,
    width: msb - lsb + 1,
    type: String(f.type || (f.enums ? 'enum' : 'uint')).toLowerCase(),
    reserved: Boolean(f.reserved) || /^rsvd|^reserved/i.test(fname.trim()),
    scale: f.scale !== undefined ? Number(f.scale) : null,
    valueOffset: f.valueOffset !== undefined ? Number(f.valueOffset) : 0,
    unit: f.unit ? String(f.unit) : '',
    qFormat: f.qFormat ? String(f.qFormat).toUpperCase() : null,
    formula: f.formula ? String(f.formula) : (f.expr ? String(f.expr) : null),
    description: String(f.description || ''),
    enums: f.enums || null
  };
}

function normalizeFields(reg, size, index) {
  const totalBits = size * 8;
  const rawFields = Array.isArray(reg.fields) ? reg.fields :
      Array.isArray(reg.bitfields)            ? reg.bitfields :
                                                [{
                                                  name: reg.name || `REG_${index}`,
                                       bits: `${totalBits - 1}:0`,
                                       type: reg.type || 'hex',
                                       description: reg.description || ''
                                     }];
  return rawFields.map(normalizeBitField).sort((a, b) => b.msb - a.msb);
}

function normalizeEntryFieldList(rawFields) {
  let cursor = 0;
  return (rawFields || []).map((f, idx) => {
    const offset = f.offset !== undefined ? parseNumber(f.offset, cursor) : cursor;
    const size = Math.max(1, parseInt(f.size ?? 4, 10) || 4);
    cursor = offset + size;
    return {
      name: String(f.name || `FIELD_${idx}`),
      offset,
      size,
      endianness: f.endianness ? (String(f.endianness).toLowerCase().startsWith('big') ? 'big' : 'little') : null,
      type: String(f.type || (f.enums ? 'enum' : 'uint')).toLowerCase(),
      scale: f.scale !== undefined ? Number(f.scale) : null,
      valueOffset: f.valueOffset !== undefined ? Number(f.valueOffset) : 0,
      unit: f.unit ? String(f.unit) : '',
      qFormat: f.qFormat ? String(f.qFormat).toUpperCase() : null,
      formula: f.formula ? String(f.formula) : (f.expr ? String(f.expr) : null),
      description: String(f.description || ''),
      enums: f.enums || null
    };
  });
}

function normalizeDiscriminator(rawDisc, defaultMask) {
  if (!rawDisc) return {offset: 0, size: 1, mask: defaultMask};
  return {
    offset: parseNumber(rawDisc.offset, 0),
    size: Math.max(1, Math.min(4, parseNumber(rawDisc.size, 1))),
    mask: parseNumber(rawDisc.mask, defaultMask)
  };
}

function normalizeVariantMap(rawVariants, defaultPrefix, buildExtra) {
  const variants = {};
  for (const [k, v] of Object.entries(rawVariants || {})) {
    const numKey = parseNumber(k, 0);
    const normKey = '0x' + numKey.toString(16).toUpperCase().padStart(2, '0');
    variants[normKey] = {
      keyNum: numKey,
      keyHex: normKey,
      name: String(v.name || `${defaultPrefix}_${normKey}`),
      description: String(v.description || ''),
      rules: Array.isArray(v.rules) ? v.rules : [],
      ...buildExtra(v)
    };
  }
  return variants;
}

/**
 * Validate and normalize a *.binsight.json object or JSON string (v2.0)
 */
function parseBinsightSchema(input, idOverride = null, filePath = null) {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid Binsight schema: root must be a JSON object.');
  }

  const VALID_MODES = ['registers', 'struct-view', 'record-trace', 'protocol-analyze'];
  const mode = String(raw.mode || 'registers').toLowerCase();
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Unsupported Binsight schema mode "${raw.mode}". Expected one of: ${VALID_MODES.join(', ')}.`);
  }
  const endianness = String(raw.endianness || 'little').toLowerCase().startsWith('big') ? 'big' : 'little';
  const baseAddress = parseNumber(raw.baseAddress, 0);
  const sourceText = typeof input === 'string' ? input : JSON.stringify(raw, null, 2);

  const baseMeta = {
    id: idOverride || raw.id || `schema-${raw.name || mode}`,
    filePath: filePath || null,
    mode,
    name: String(raw.name || mode.toUpperCase()),
    description: String(raw.description || ''),
    endianness,
    baseAddress,
    rules: Array.isArray(raw.rules) ? raw.rules : [],
    registers: [],
    groups: [],
    sourceText
  };

  if (mode === 'struct-view') {
    const fields = normalizeEntryFieldList(raw.fields || []);
    const maxSpan = fields.reduce((m, f) => Math.max(m, f.offset + f.size), 0);
    return {
      ...baseMeta,
      byteSpan: Math.max(1, raw.structSize ? parseNumber(raw.structSize, maxSpan) : maxSpan),
      fields
    };
  }

  if (mode === 'record-trace') {
    const entrySize = Math.max(1, parseNumber(raw.entrySize, 64));
    const blockSize = raw.blockSize ? parseNumber(raw.blockSize, 0) : 0;
    const defVarRaw = raw.defaultVariant || {name: 'ENTRY', fields: raw.fields || []};
    return {
      ...baseMeta,
      blockSize,
      entrySize,
      entriesPerBlock: blockSize > 0 ? Math.floor(blockSize / entrySize) : 0,
      paddingPerBlock: blockSize > 0 ? blockSize % entrySize : 0,
      byteSpan: entrySize,
      discriminator: normalizeDiscriminator(raw.discriminator, 0xff),
      variants: normalizeVariantMap(
          raw.variants, 'TYPE', (v) => ({
                                  skip: Boolean(v.skip),
                                  summaryFields: Array.isArray(v.summaryFields) ? v.summaryFields : [],
                                  embeddedProtocol: v.embeddedProtocol ? {
                                    schemaId: String(v.embeddedProtocol.schemaId || 'builtin-protocol-ufs-upiu'),
                                    offset: parseNumber(v.embeddedProtocol.offset, 0),
                                    length: parseNumber(v.embeddedProtocol.length, 32)
                                  } : null,
                                  fields: normalizeEntryFieldList(v.fields || [])
                                })),
      defaultVariant: {
        name: String(defVarRaw.name || 'ENTRY'),
        description: String(defVarRaw.description || ''),
        skip: Boolean(defVarRaw.skip),
        summaryFields: Array.isArray(defVarRaw.summaryFields) ? defVarRaw.summaryFields : [],
        rules: Array.isArray(defVarRaw.rules) ? defVarRaw.rules : [],
        fields: normalizeEntryFieldList(defVarRaw.fields || [])
      }
    };
  }

  if (mode === 'protocol-analyze') {
    const framing = {
      headerSize: parseNumber(raw.packetFraming?.headerSize, 32),
      ehsLenOffset: raw.packetFraming?.ehsLenOffset !== undefined ? parseNumber(raw.packetFraming.ehsLenOffset, -1) :
                                                                    -1,
      dataSegLenOffset:
          raw.packetFraming?.dataSegLenOffset !== undefined ? parseNumber(raw.packetFraming.dataSegLenOffset, -1) : -1
    };
    const normalizeRows = (rows) => (rows || []).map((r, rIdx) => ({
      row: r.row !== undefined ? Number(r.row) : rIdx,
      fields: (r.fields || []).map(normalizeBitField).sort((a, b) => b.msb - a.msb)
    }));
    const payloadSchemas = {};
    if (raw.payloadSchemas && typeof raw.payloadSchemas === 'object') {
      for (const [k, ps] of Object.entries(raw.payloadSchemas)) {
        payloadSchemas[k] = {
          name: String(ps.name || k),
          endianness: ps.endianness ? String(ps.endianness).toLowerCase() : null,
          fields: normalizeEntryFieldList(ps.fields || [])
        };
      }
    }
    return {
      ...baseMeta,
      wordWidth: parseNumber(raw.wordWidth, 4),
      packetFraming: framing,
      byteSpan: framing.headerSize,
      discriminator: normalizeDiscriminator(raw.discriminator, 0x3f),
      payloadSchemas,
      variants: normalizeVariantMap(
          raw.variants, 'PKT',
          (v) => ({
            rows: normalizeRows(v.rows),
            payloadRef: v.payloadRef || null,
            subVariants: v.subVariants ? {
              discriminator: normalizeDiscriminator(v.subVariants.discriminator, 0xff),
              variants: normalizeVariantMap(v.subVariants.variants, 'SUB', (sv) => ({rows: normalizeRows(sv.rows)}))
            } : null
          }))
    };
  }

  // MODE: registers (Default)
  const rawRegs = Array.isArray(raw.registers) ? raw.registers : Array.isArray(raw.fields) ? raw.fields : [];
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
  if (rawRegs.length === 0 && rawGroups.length === 0) {
    throw new Error('Invalid Binsight schema: must contain "registers" or "groups".');
  }

  let maxEndOffset = 0;
  let autoOffset = 0;
  const expandedRegisters = [];
  const groupMetadata = [];

  const pushReg = (reg, index, itemName, itemOffset, size, groupName, groupIndex, desc) => {
    if (itemOffset + size > maxEndOffset) maxEndOffset = itemOffset + size;
    expandedRegisters.push({
      name: itemName,
      offset: itemOffset,
      size,
      access: String(reg.access || 'RW').toUpperCase(),
      resetValue: reg.resetValue !== undefined && reg.resetValue !== null ? String(reg.resetValue) : null,
      description: desc,
      groupName,
      groupIndex,
      fields: normalizeFields(reg, size, index)
    });
  };

  rawRegs.forEach((reg, index) => {
    const baseOff = reg.offset !== undefined && reg.offset !== null ? parseNumber(reg.offset, autoOffset) : autoOffset;
    const size = [1, 2, 4, 8].includes(Number(reg.size)) ? Number(reg.size) : 4;
    const count = Math.max(1, parseInt(reg.count ?? 1, 10) || 1);
    const stride = reg.stride !== undefined ? Math.max(size, parseNumber(reg.stride, size)) : size;

    if (count > 1) groupMetadata.push({name: String(reg.name || `ARR_${index}`), count});
    for (let c = 0; c < count; c++) {
      const itemOffset = baseOff + c * stride;
      autoOffset = itemOffset + size;
      const itemName = count > 1 ? `${reg.name || `REG_${index}`}[${c}]` :
                                   String(reg.name || `REG_0x${itemOffset.toString(16).toUpperCase()}`);
      const desc = count > 1 ? `${reg.description || ''} (Index ${c})`.trim() : String(reg.description || '');
      pushReg(
          reg, index, itemName, itemOffset, size, count > 1 ? String(reg.name || `ARR_${index}`) : null,
          count > 1 ? c : null, desc);
    }
  });

  rawGroups.forEach((grp, gIdx) => {
    const grpName = String(grp.name || `GROUP_${gIdx}`);
    const grpBaseOffset = parseNumber(grp.offset, autoOffset);
    const grpCount = Math.max(1, parseInt(grp.count ?? 1, 10) || 1);
    const grpRegs = Array.isArray(grp.registers) ? grp.registers : [];

    let relCursor = 0;
    const singleSpan = grpRegs.reduce((m, r) => {
      const rOff = r.offset !== undefined ? parseNumber(r.offset, relCursor) : relCursor;
      const rSize = [1, 2, 4, 8].includes(Number(r.size)) ? Number(r.size) : 4;
      relCursor = rOff + rSize;
      return Math.max(m, relCursor);
    }, 0);
    const grpStride =
        grp.stride !== undefined ? Math.max(singleSpan, parseNumber(grp.stride, singleSpan)) : Math.max(4, singleSpan);
    groupMetadata.push({name: grpName, count: grpCount, description: String(grp.description || '')});

    for (let inst = 0; inst < grpCount; inst++) {
      const instBase = grpBaseOffset + inst * grpStride;
      let innerCursor = 0;
      grpRegs.forEach((reg, rIdx) => {
        const relOff = reg.offset !== undefined ? parseNumber(reg.offset, innerCursor) : innerCursor;
        const size = [1, 2, 4, 8].includes(Number(reg.size)) ? Number(reg.size) : 4;
        innerCursor = relOff + size;
        pushReg(
            reg, rIdx, `${grpName}[${inst}].${reg.name || `REG_${rIdx}`}`, instBase + relOff, size, grpName, inst,
            `${grpName}[${inst}] — ${reg.description || reg.name || ''}`.trim());
      });
    }
  });

  expandedRegisters.sort((a, b) => a.offset - b.offset);

  return {
    ...baseMeta,
    mode: 'registers',
    name: String(raw.name || 'CUSTOM_IP'),
    byteSpan: Math.max(1, maxEndOffset),
    groups: groupMetadata,
    registers: expandedRegisters
  };
}

function parseLayoutProfile(input) {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.segments)) {
    throw new Error('Invalid Layout Profile: must contain a "segments" array.');
  }

  return {
    name: String(raw.name || 'Multi-Segment Layout'),
    description: String(raw.description || ''),
    segments: raw.segments.map(
        (seg, idx) => ({
          label: String(seg.label || `Segment_${idx + 1}`),
          startOffset: parseNumber(seg.startOffset, 0),
          hwBaseAddress: seg.hwBaseAddress !== undefined && seg.hwBaseAddress !== null ?
              parseNumber(seg.hwBaseAddress, null) :
              null,
          schemaRef: String(seg.schema || 'builtin-sys-ctrl'),
          endianness: seg.endianness ? (String(seg.endianness).toLowerCase().startsWith('big') ? 'big' : 'little') :
                                       null
        }))
  };
}

let cachedBuiltinSchemas = null;
function getBuiltinSchemas() {
  if (cachedBuiltinSchemas) return cachedBuiltinSchemas;
  const schemasDir = path.join(__dirname, '..', 'schemas');
  if (!fs.existsSync(schemasDir)) return [];
  cachedBuiltinSchemas = fs.readdirSync(schemasDir).filter((f) => f.endsWith('.binsight.json')).sort().map((f) => {
    const text = fs.readFileSync(path.join(schemasDir, f), 'utf8');
    const raw = JSON.parse(text);
    return parseBinsightSchema(text, raw.id || `builtin-${f}`, null);
  });
  return cachedBuiltinSchemas;
}

module.exports = {
  getBuiltinSchemas,
  parseBinsightSchema,
  parseLayoutProfile,
  parseNumber
};
