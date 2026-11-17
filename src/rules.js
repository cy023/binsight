/**
 * Shared declarative rule evaluator for Repeat Struct (Mode 2) & Protocol Diagram (Mode 3) entries.
 * Rules can be attached to a variant (`variant.rules`) or schema (`schema.rules`).
 * Rule format:
 *   { name?, field?, offset?, size?, msb?, lsb?, op: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'bitmask_any'|'bitmask_all',
 * value, severity: 'error'|'warn'|'info', message }
 */

function readBytesNum(bytes, offset, size, endian) {
  let val = 0;
  for (let i = 0; i < size; i++) {
    const idx = offset + i;
    const b = idx >= 0 && idx < bytes.length ? bytes[idx] : 0;
    val = endian === 'big' ? val * 256 + b : val + b * Math.pow(256, i);
  }
  return val;
}

function findFieldSpec(variant, fieldName) {
  if (!variant || !fieldName) return null;
  if (Array.isArray(variant.fields)) {
    const f = variant.fields.find((x) => x.name === fieldName);
    if (f) return {offset: f.offset, size: f.size || 4, msb: null, lsb: null};
  }
  if (Array.isArray(variant.rows)) {
    for (const r of variant.rows) {
      const f = (r.fields || []).find((x) => x.name === fieldName);
      if (f) return {offset: r.row * 4, size: 4, msb: f.msb, lsb: f.lsb};
    }
  }
  return null;
}

function compareRuleOp(actual, op, expected) {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'gt':
      return actual > expected;
    case 'gte':
      return actual >= expected;
    case 'lt':
      return actual < expected;
    case 'lte':
      return actual <= expected;
    case 'bitmask_any':
      return (actual & expected) !== 0;
    case 'bitmask_all':
      return (actual & expected) === expected;
    default:
      return false;
  }
}

const SEVERITY_RANK = {
  error: 3,
  warn: 2,
  info: 1
};

function evaluateEntryRules(bytes, variant, schema, endian = 'little') {
  const rules =
      [...(Array.isArray(schema?.rules) ? schema.rules : []), ...(Array.isArray(variant?.rules) ? variant.rules : [])];
  if (rules.length === 0) return {severity: null, ruleHits: []};

  const hits = [];
  let maxRank = 0;
  let maxSev = null;

  for (const rule of rules) {
    const spec = rule.field ? findFieldSpec(variant, rule.field) : null;
    const offset = rule.offset !== undefined ? Number(rule.offset) : spec?.offset;
    const size = rule.size !== undefined ? Number(rule.size) : spec?.size || 4;
    if (offset === undefined || offset === null || offset + size > bytes.length) continue;

    let actual = readBytesNum(bytes, offset, size, endian);
    const msb = rule.msb !== undefined ? Number(rule.msb) : spec?.msb;
    const lsb = rule.lsb !== undefined ? Number(rule.lsb) : spec?.lsb;
    if (msb !== null && msb !== undefined && lsb !== null && lsb !== undefined) {
      const mask = (1 << (msb - lsb + 1)) - 1;
      actual = (actual >>> lsb) & mask;
    }

    const expected =
        typeof rule.value === 'string' && rule.value.startsWith('0x') ? parseInt(rule.value, 16) : Number(rule.value);

    if (compareRuleOp(actual, rule.op || 'eq', expected)) {
      const sev = SEVERITY_RANK[rule.severity] ? rule.severity : 'warn';
      hits.push({
        severity: sev,
        name: rule.name || rule.field || 'RULE',
        message: rule.message || `${rule.field || `@0x${offset.toString(16)}`} ${rule.op} ${rule.value}`
      });
      if (SEVERITY_RANK[sev] > maxRank) {
        maxRank = SEVERITY_RANK[sev];
        maxSev = sev;
      }
    }
  }

  return {severity: maxSev, ruleHits: hits};
}

module.exports = {evaluateEntryRules};
