const _POINT_B64_LENGTH = 8;
const FIRST_POINT_B64_LENGTH = 16;
const FIRST_POINT_2D_B64_LENGTH = 12;
const DEFAULT_PRESSURE = 0.5;
const DIM_2D = 2;
const DIM_3D = 3;
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i;
}
const SIX_BIT_MASK = 63;
const PADDING_CHAR_CODE = "=".charCodeAt(0);
const POW2 = new Float64Array(31);
for (let i = 0; i < 31; i++) {
  POW2[i] = Math.pow(2, i - 15);
}
const POW2_SUBNORMAL = Math.pow(2, -14) / 1024;
const MANTISSA = new Float64Array(1024);
for (let i = 0; i < 1024; i++) {
  MANTISSA[i] = 1 + i / 1024;
}
function nativeGetFloat16(dataView, offset) {
  return dataView.getFloat16(offset, true);
}
function fallbackGetFloat16(dataView, offset) {
  return float16BitsToNumber(dataView.getUint16(offset, true));
}
const getFloat16 = typeof DataView.prototype.getFloat16 === "function" ? nativeGetFloat16 : fallbackGetFloat16;
function nativeSetFloat16(dataView, offset, value) {
  ;
  dataView.setFloat16(offset, value, true);
}
function fallbackSetFloat16(dataView, offset, value) {
  dataView.setUint16(offset, numberToFloat16Bits(value), true);
}
const setFloat16 = typeof DataView.prototype.setFloat16 === "function" ? nativeSetFloat16 : fallbackSetFloat16;
function nativeBase64ToUint8Array(base64) {
  return Uint8Array.fromBase64(base64);
}
function fallbackBase64ToUint8Array(base64) {
  const paddedLength = base64.length;
  let padding = 0;
  if (paddedLength > 0 && base64.charCodeAt(paddedLength - 1) === PADDING_CHAR_CODE) {
    padding++;
    if (paddedLength > 1 && base64.charCodeAt(paddedLength - 2) === PADDING_CHAR_CODE) {
      padding++;
    }
  }
  const numBytes = Math.floor(paddedLength * 3 / 4) - padding;
  const bytes = new Uint8Array(numBytes);
  let byteIndex = 0;
  const fullGroups = Math.floor((paddedLength - padding) / 4) * 4;
  for (let i = 0; i < fullGroups; i += 4) {
    const c0 = B64_LOOKUP[base64.charCodeAt(i)];
    const c1 = B64_LOOKUP[base64.charCodeAt(i + 1)];
    const c2 = B64_LOOKUP[base64.charCodeAt(i + 2)];
    const c3 = B64_LOOKUP[base64.charCodeAt(i + 3)];
    const bitmap = c0 << 18 | c1 << 12 | c2 << 6 | c3;
    bytes[byteIndex++] = bitmap >> 16 & 255;
    bytes[byteIndex++] = bitmap >> 8 & 255;
    bytes[byteIndex++] = bitmap & 255;
  }
  if (padding === 1) {
    const c0 = B64_LOOKUP[base64.charCodeAt(fullGroups)];
    const c1 = B64_LOOKUP[base64.charCodeAt(fullGroups + 1)];
    const c2 = B64_LOOKUP[base64.charCodeAt(fullGroups + 2)];
    const bitmap = c0 << 18 | c1 << 12 | c2 << 6;
    bytes[byteIndex++] = bitmap >> 16 & 255;
    bytes[byteIndex++] = bitmap >> 8 & 255;
  } else if (padding === 2) {
    const c0 = B64_LOOKUP[base64.charCodeAt(fullGroups)];
    const c1 = B64_LOOKUP[base64.charCodeAt(fullGroups + 1)];
    const bitmap = c0 << 18 | c1 << 12;
    bytes[byteIndex++] = bitmap >> 16 & 255;
  }
  return bytes;
}
function nativeUint8ArrayToBase64(uint8Array) {
  return uint8Array.toBase64();
}
function fallbackUint8ArrayToBase64(uint8Array) {
  const len = uint8Array.length;
  const fullGroups = Math.floor(len / 3) * 3;
  let result = "";
  for (let i = 0; i < fullGroups; i += 3) {
    const byte1 = uint8Array[i];
    const byte2 = uint8Array[i + 1];
    const byte3 = uint8Array[i + 2];
    const bitmap = byte1 << 16 | byte2 << 8 | byte3;
    result += BASE64_CHARS[bitmap >> 18 & SIX_BIT_MASK] + // bits 23–18 (top sextet)
    BASE64_CHARS[bitmap >> 12 & SIX_BIT_MASK] + // bits 17–12
    BASE64_CHARS[bitmap >> 6 & SIX_BIT_MASK] + // bits 11–6
    BASE64_CHARS[bitmap & SIX_BIT_MASK];
  }
  const remaining = len - fullGroups;
  if (remaining === 1) {
    const bitmap = uint8Array[fullGroups] << 16;
    result += BASE64_CHARS[bitmap >> 18 & SIX_BIT_MASK] + BASE64_CHARS[bitmap >> 12 & SIX_BIT_MASK] + "==";
  } else if (remaining === 2) {
    const bitmap = uint8Array[fullGroups] << 16 | uint8Array[fullGroups + 1] << 8;
    result += BASE64_CHARS[bitmap >> 18 & SIX_BIT_MASK] + BASE64_CHARS[bitmap >> 12 & SIX_BIT_MASK] + BASE64_CHARS[bitmap >> 6 & SIX_BIT_MASK] + "=";
  }
  return result;
}
const uint8ArrayToBase64 = typeof Uint8Array.prototype.toBase64 === "function" ? nativeUint8ArrayToBase64 : fallbackUint8ArrayToBase64;
const base64ToUint8Array = typeof Uint8Array.fromBase64 === "function" ? nativeBase64ToUint8Array : fallbackBase64ToUint8Array;
function float16BitsToNumber(bits) {
  const sign = bits >> 15;
  const exp = bits >> 10 & 31;
  const frac = bits & 1023;
  if (exp === 0) {
    return sign ? -frac * POW2_SUBNORMAL : frac * POW2_SUBNORMAL;
  }
  if (exp === 31) {
    return frac ? NaN : sign ? -Infinity : Infinity;
  }
  const magnitude = POW2[exp] * MANTISSA[frac];
  return sign ? -magnitude : magnitude;
}
function numberToFloat16Bits(value) {
  if (value === 0) return Object.is(value, -0) ? 32768 : 0;
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return 32256;
    return value > 0 ? 31744 : 64512;
  }
  const sign = value < 0 ? 1 : 0;
  value = Math.abs(value);
  const exp = Math.floor(Math.log2(value));
  let expBiased = exp + 15;
  if (expBiased >= 31) {
    return sign << 15 | 31744;
  }
  if (expBiased <= 0) {
    const frac2 = Math.round(value * Math.pow(2, 14) * 1024);
    return sign << 15 | frac2 & 1023;
  }
  const mantissa = value / Math.pow(2, exp) - 1;
  let frac = Math.round(mantissa * 1024);
  if (frac >= 1024) {
    frac = 0;
    expBiased++;
    if (expBiased >= 31) {
      return sign << 15 | 31744;
    }
  }
  return sign << 15 | expBiased << 10 | frac;
}
class b64Vecs {
  /**
   * Encode a single point (x, y, z) to 8 base64 characters using legacy Float16 encoding.
   * Each coordinate is encoded as a Float16 value, resulting in 6 bytes total.
   *
   * @param x - The x coordinate
   * @param y - The y coordinate
   * @param z - The z coordinate
   * @returns An 8-character base64 string representing the point
   * @internal
   */
  static _legacyEncodePoint(x, y, z) {
    const buffer = new Uint8Array(6);
    const dataView = new DataView(buffer.buffer);
    setFloat16(dataView, 0, x);
    setFloat16(dataView, 2, y);
    setFloat16(dataView, 4, z);
    return uint8ArrayToBase64(buffer);
  }
  /**
   * Convert an array of VecModels to a base64 string using legacy Float16 encoding.
   * Uses Float16 encoding for each coordinate (x, y, z). If a point's z value is
   * undefined, it defaults to 0.5.
   *
   * @param points - An array of VecModel objects to encode
   * @returns A base64-encoded string containing all points
   * @internal Used only for migrations from legacy format
   */
  static _legacyEncodePoints(points) {
    if (points.length === 0) return "";
    const buffer = new Uint8Array(points.length * 6);
    const dataView = new DataView(buffer.buffer);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const offset = i * 6;
      setFloat16(dataView, offset, p.x);
      setFloat16(dataView, offset + 2, p.y);
      setFloat16(dataView, offset + 4, p.z ?? 0.5);
    }
    return uint8ArrayToBase64(buffer);
  }
  /**
   * Convert a legacy base64 string back to an array of VecModels.
   * Decodes Float16-encoded coordinates (x, y, z) from the base64 string.
   *
   * @param base64 - The base64-encoded string containing point data
   * @returns An array of VecModel objects decoded from the string
   * @internal Used only for migrations from legacy format
   */
  static _legacyDecodePoints(base64) {
    const bytes = base64ToUint8Array(base64);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = [];
    for (let offset = 0; offset < bytes.length; offset += 6) {
      result.push({
        x: getFloat16(dataView, offset),
        y: getFloat16(dataView, offset + 2),
        z: getFloat16(dataView, offset + 4)
      });
    }
    return result;
  }
  /**
   * Encode an array of VecModels using delta encoding for improved precision.
   * The first point is stored as Float32 (high precision for absolute position),
   * subsequent points are stored as Float16 deltas from the previous point.
   * This provides full precision for the starting position and excellent precision
   * for deltas between consecutive points (which are typically small values).
   *
   * Format:
   * - First point: 3 Float32 values = 12 bytes = 16 base64 chars
   * - Delta points: 3 Float16 values each = 6 bytes = 8 base64 chars each
   *
   * @param points - An array of VecModel objects to encode
   * @param dim - Encoding dimension; `2` routes through the 2D variant (drops z), `3` (default) keeps x, y, z
   * @returns A base64-encoded string containing delta-encoded points
   * @public
   */
  static encodePoints(points, dim) {
    if (dim === DIM_2D) return b64Vecs.encodePoints2D(points);
    if (points.length === 0) return "";
    const firstPointBytes = 12;
    const deltaBytes = (points.length - 1) * 6;
    const totalBytes = firstPointBytes + deltaBytes;
    const buffer = new Uint8Array(totalBytes);
    const dataView = new DataView(buffer.buffer);
    const first = points[0];
    dataView.setFloat32(0, first.x, true);
    dataView.setFloat32(4, first.y, true);
    dataView.setFloat32(8, first.z ?? 0.5, true);
    let prevX = first.x;
    let prevY = first.y;
    let prevZ = first.z ?? 0.5;
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      const z = p.z ?? 0.5;
      const offset = firstPointBytes + (i - 1) * 6;
      setFloat16(dataView, offset, p.x - prevX);
      setFloat16(dataView, offset + 2, p.y - prevY);
      setFloat16(dataView, offset + 4, z - prevZ);
      prevX = p.x;
      prevY = p.y;
      prevZ = z;
    }
    return uint8ArrayToBase64(buffer);
  }
  /**
   * Decode a delta-encoded base64 string back to an array of absolute VecModels.
   * The first point is stored as Float32 (high precision), subsequent points are
   * Float16 deltas that are accumulated to reconstruct absolute positions.
   *
   * @param base64 - The base64-encoded string containing delta-encoded point data
   * @param dim - Encoding dimension; `2` expects x/y only (z supplied as 0.5), `3` (default) expects x/y/z
   * @returns An array of VecModel objects with absolute coordinates
   * @public
   */
  static decodePoints(base64, dim) {
    if (dim === DIM_2D) return b64Vecs.decodePoints2D(base64);
    if (base64.length === 0) return [];
    const bytes = base64ToUint8Array(base64);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = [];
    let x = dataView.getFloat32(0, true);
    let y = dataView.getFloat32(4, true);
    let z = dataView.getFloat32(8, true);
    result.push({ x, y, z });
    const firstPointBytes = 12;
    for (let offset = firstPointBytes; offset < bytes.length; offset += 6) {
      x += getFloat16(dataView, offset);
      y += getFloat16(dataView, offset + 2);
      z += getFloat16(dataView, offset + 4);
      result.push({ x, y, z });
    }
    return result;
  }
  /**
   * Get the first point from a delta-encoded base64 string.
   * The first point is stored as Float32 for full precision.
   *
   * @param b64Points - The delta-encoded base64 string
   * @param dim - Encoding dimension; `2` expects x/y only (z supplied as 0.5), `3` (default) expects x/y/z
   * @returns The first point as a VecModel, or null if the string is too short
   * @public
   */
  static decodeFirstPoint(b64Points, dim) {
    if (dim === DIM_2D) return b64Vecs.decodeFirstPoint2D(b64Points);
    if (b64Points.length < FIRST_POINT_B64_LENGTH) return null;
    const bytes = base64ToUint8Array(b64Points.slice(0, FIRST_POINT_B64_LENGTH));
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      x: dataView.getFloat32(0, true),
      y: dataView.getFloat32(4, true),
      z: dataView.getFloat32(8, true)
    };
  }
  /**
   * Get the last point from a delta-encoded base64 string.
   * Requires decoding all points to accumulate deltas.
   *
   * @param b64Points - The delta-encoded base64 string
   * @param dim - Encoding dimension; `2` expects x/y only (z supplied as 0.5), `3` (default) expects x/y/z
   * @returns The last point as a VecModel, or null if the string is too short
   * @public
   */
  static decodeLastPoint(b64Points, dim) {
    if (dim === DIM_2D) return b64Vecs.decodeLastPoint2D(b64Points);
    if (b64Points.length < FIRST_POINT_B64_LENGTH) return null;
    const bytes = base64ToUint8Array(b64Points);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let x = dataView.getFloat32(0, true);
    let y = dataView.getFloat32(4, true);
    let z = dataView.getFloat32(8, true);
    const firstPointBytes = 12;
    for (let offset = firstPointBytes; offset < bytes.length; offset += 6) {
      x += getFloat16(dataView, offset);
      y += getFloat16(dataView, offset + 2);
      z += getFloat16(dataView, offset + 4);
    }
    return { x, y, z };
  }
  /**
   * Encode an array of VecModels as 2D delta-encoded points, dropping z entirely.
   * Use for draw shapes from devices that don't report pressure, where z is a
   * constant 0.5 and storing it wastes ~33% of per-point bytes.
   *
   * Format:
   * - First point: 2 Float32 values (x, y) = 8 bytes
   * - Delta points: 2 Float16 values (dx, dy) = 4 bytes each
   *
   * @param points - An array of VecModel objects to encode (z is discarded)
   * @returns A base64-encoded string containing 2D delta-encoded points
   * @public
   */
  static encodePoints2D(points) {
    if (points.length === 0) return "";
    const firstPointBytes = 8;
    const deltaBytes = (points.length - 1) * 4;
    const buffer = new Uint8Array(firstPointBytes + deltaBytes);
    const dataView = new DataView(buffer.buffer);
    const first = points[0];
    dataView.setFloat32(0, first.x, true);
    dataView.setFloat32(4, first.y, true);
    let prevX = first.x;
    let prevY = first.y;
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      const offset = firstPointBytes + (i - 1) * 4;
      setFloat16(dataView, offset, p.x - prevX);
      setFloat16(dataView, offset + 2, p.y - prevY);
      prevX = p.x;
      prevY = p.y;
    }
    return uint8ArrayToBase64(buffer);
  }
  /**
   * Decode a 2D delta-encoded base64 string back to an array of absolute VecModels.
   * The z coordinate is always set to 0.5 (the default pressure value) so downstream
   * consumers don't need a separate code path.
   *
   * @param base64 - The base64-encoded string containing 2D delta-encoded point data
   * @returns An array of VecModel objects with absolute (x, y) and z = 0.5
   * @public
   */
  static decodePoints2D(base64) {
    if (base64.length === 0) return [];
    const bytes = base64ToUint8Array(base64);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = [];
    let x = dataView.getFloat32(0, true);
    let y = dataView.getFloat32(4, true);
    result.push({ x, y, z: DEFAULT_PRESSURE });
    const firstPointBytes = 8;
    for (let offset = firstPointBytes; offset < bytes.length; offset += 4) {
      x += getFloat16(dataView, offset);
      y += getFloat16(dataView, offset + 2);
      result.push({ x, y, z: DEFAULT_PRESSURE });
    }
    return result;
  }
  /**
   * Get the first point from a 2D delta-encoded base64 string.
   *
   * @param b64Points - The 2D delta-encoded base64 string
   * @returns The first point with z = 0.5, or null if the string is too short
   * @public
   */
  static decodeFirstPoint2D(b64Points) {
    if (b64Points.length < FIRST_POINT_2D_B64_LENGTH) return null;
    const bytes = base64ToUint8Array(b64Points.slice(0, FIRST_POINT_2D_B64_LENGTH));
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      x: dataView.getFloat32(0, true),
      y: dataView.getFloat32(4, true),
      z: DEFAULT_PRESSURE
    };
  }
  /**
   * Get the last point from a 2D delta-encoded base64 string.
   * Requires decoding all points to accumulate deltas.
   *
   * @param b64Points - The 2D delta-encoded base64 string
   * @returns The last point with z = 0.5, or null if the string is too short
   * @public
   */
  static decodeLastPoint2D(b64Points) {
    if (b64Points.length < FIRST_POINT_2D_B64_LENGTH) return null;
    const bytes = base64ToUint8Array(b64Points);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let x = dataView.getFloat32(0, true);
    let y = dataView.getFloat32(4, true);
    const firstPointBytes = 8;
    for (let offset = firstPointBytes; offset < bytes.length; offset += 4) {
      x += getFloat16(dataView, offset);
      y += getFloat16(dataView, offset + 2);
    }
    return { x, y, z: DEFAULT_PRESSURE };
  }
  /**
   * Whether an encoded path contains only a single point (a "dot"), inferred from
   * the encoded length without decoding — cheap enough for the render path.
   *
   * The single-point length depends on the encoding dimension, so this takes the
   * segment's `dim`: a one-point path is `FIRST_POINT_B64_LENGTH` chars (3D) or
   * `FIRST_POINT_2D_B64_LENGTH` chars (2D). Keeping this beside the layout constants
   * is deliberate — it is the single source of truth for "how long is one point", so
   * callers never hard-code a length threshold (which silently breaks when a new
   * encoding is added).
   *
   * @param b64Points - The encoded path string
   * @param dim - Encoding dimension; `2` for (x, y), `3` (default) for (x, y, z)
   * @returns true if the path encodes exactly one point
   * @public
   */
  static isSinglePoint(b64Points, dim) {
    return b64Points.length <= (dim === DIM_2D ? FIRST_POINT_2D_B64_LENGTH : FIRST_POINT_B64_LENGTH);
  }
}
export {
  DIM_2D,
  DIM_3D,
  b64Vecs,
  fallbackBase64ToUint8Array,
  fallbackUint8ArrayToBase64,
  float16BitsToNumber,
  numberToFloat16Bits
};
//# sourceMappingURL=b64Vecs.mjs.map
