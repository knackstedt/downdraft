/**
 * Safety bounds for asset parser validation.
 * These limits prevent decompression bombs, OOM, and integer overflow from
 * malformed or malicious files.
 */
export const MAX_VERTEX_COUNT = 50_000_000;
export const MAX_FACE_COUNT = 100_000_000;
export const MAX_TEXTURE_DIM = 16384;
export const MAX_MIP_LEVELS = 16;
export const MAX_DECOMPRESS_SIZE = 512 * 1024 * 1024; // 512 MB
export const MAX_FETCH_SIZE = 256 * 1024 * 1024; // 256 MB
export const MAX_NODE_DEPTH = 64;
export const MAX_ARRAY_LENGTH = 100_000_000;

/**
 * Asserts that `offset + length` does not exceed `max`.
 * Throws a `RangeError` with a descriptive message if violated.
 */
export function assertBounds(name: string, offset: number, length: number, max: number): void {
  if (offset < 0 || length < 0) {
    throw new RangeError(`${name}: negative offset (${offset}) or length (${length})`);
  }
  if (offset + length > max) {
    throw new RangeError(`${name}: offset ${offset} + length ${length} exceeds max ${max}`);
  }
}

/**
 * Asserts that `count` is a non-negative integer not exceeding `max`.
 * Throws a `RangeError` if violated.
 */
export function assertCount(name: string, count: number, max: number): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`${name}: count ${count} is not a non-negative integer`);
  }
  if (count > max) {
    throw new RangeError(`${name}: count ${count} exceeds max ${max}`);
  }
}

/**
 * Asserts that `value` is a finite number (not NaN, not Infinity).
 * Throws a `RangeError` if violated.
 */
export function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name}: value ${value} is not finite`);
  }
}

/**
 * Asserts that `value` is a positive finite number.
 * Throws a `RangeError` if violated.
 */
export function assertPositive(name: string, value: number): void {
  assertFinite(name, value);
  if (value <= 0) {
    throw new RangeError(`${name}: value ${value} is not positive`);
  }
}

/**
 * Clamps a value to `[min, max]`.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamps a value to `[0, Number.MAX_SAFE_INTEGER]`.
 * Useful for gold/currency/quantity values.
 */
export function clampSafeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, Number.MAX_SAFE_INTEGER));
}
