'use strict';

/**
 * Convert a KNX group address number (0..65535) into string format.
 * @param {number} addr
 * @param {'ThreeLevel'|'TwoLevel'|'Free'} style
 * @returns {string}
 */
function groupAddressNumberToString(addr, style) {
  if (typeof addr !== 'number' || !Number.isFinite(addr)) return String(addr);

  const safe = addr & 0xffff;

  if (style === 'TwoLevel') {
    const main = (safe >> 11) & 0x1f;
    const sub = safe & 0x7ff;
    return `${main}/${sub}`;
  }

  // Default: ThreeLevel
  const main = (safe >> 11) & 0x1f;
  const middle = (safe >> 8) & 0x07;
  const sub = safe & 0xff;
  return `${main}/${middle}/${sub}`;
}

/**
 * Normalize ETS datapoint IDs to knx.js DPT format.
 * ETS examples: "DPT-1", "DPST-1-1".
 * knx.js expects "1" or "1.001".
 * @param {string|undefined|null} etsId
 * @returns {string|undefined}
 */
function etsDptToKnxDpt(etsId) {
  if (!etsId || typeof etsId !== 'string') return undefined;

  const s = etsId.trim();
  if (!s) return undefined;

  // already numeric format
  if (/^\d+(?:\.\d+)?$/.test(s)) return s;

  // DPT-n
  let m = /^DPT-(\d+)$/.exec(s);
  if (m) return String(parseInt(m[1], 10));

  // DPST-n-n1
  m = /^DPST-(\d+)-(\d+)$/.exec(s);
  if (m) {
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    const minor3 = String(minor).padStart(3, '0');
    return `${major}.${minor3}`;
  }

  return undefined;
}

/**
 * Extract major DPT number from knx.js DPT string.
 * @param {string|undefined|null} dpt
 * @returns {number|undefined}
 */
function dptMajor(dpt) {
  if (!dpt || typeof dpt !== 'string') return undefined;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(dpt.trim());
  if (!m) return undefined;
  const major = parseInt(m[1], 10);
  if (!Number.isFinite(major)) return undefined;
  return major;
}

/**
 * Basic ioBroker common type/role inference.
 * Not exhaustive, but sufficient for a practical baseline.
 * @param {string|undefined} dpt
 * @returns {{type: ioBroker.CommonType, role: string}}
 */
function inferCommonFromDpt(dpt) {
  const major = dptMajor(dpt);

  switch (major) {
    case 1:
      return { type: 'boolean', role: 'switch' };
    case 16:
      return { type: 'string', role: 'text' };
    case 19:
      return { type: 'string', role: 'date' }; // stored as ISO string
    default:
      return { type: 'number', role: 'value' };
  }
}

/**
 * Sanitize a string to be used as an ioBroker object id segment.
 * @param {string} name
 * @returns {string}
 */
function sanitizeIdSegment(name) {
  if (typeof name !== 'string') return 'unnamed';
  const s = name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'unnamed';
}

/**
 * Coerce an incoming ioBroker state value to something knx.js Datapoint.write can handle.
 * @param {any} val
 * @param {string|undefined} dpt
 * @returns {number|string|boolean|Date}
 */
function coerceToKnxValue(val, dpt) {
  const major = dptMajor(dpt);

  if (major === 1) {
    // bool
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    if (typeof val === 'string') {
      const v = val.trim().toLowerCase();
      if (['1', 'true', 'on', 'yes'].includes(v)) return true;
      if (['0', 'false', 'off', 'no'].includes(v)) return false;
    }
    return Boolean(val);
  }

  if (major === 16) {
    // text
    if (val === null || val === undefined) return '';
    return String(val);
  }

  if (major === 19) {
    // date/time – keep as Date if possible
    if (val instanceof Date) return val;
    if (typeof val === 'number') return new Date(val);
    if (typeof val === 'string') {
      const d = new Date(val);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  }

  // numeric
  if (typeof val === 'number') return val;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (typeof val === 'string') {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }

  return 0;
}

module.exports = {
  groupAddressNumberToString,
  etsDptToKnxDpt,
  dptMajor,
  inferCommonFromDpt,
  sanitizeIdSegment,
  coerceToKnxValue
};
