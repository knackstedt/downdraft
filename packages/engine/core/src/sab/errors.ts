import { createLogger } from "../util/logger";

const log = createLogger();

const warned = new Set<string>();

let debugMode = false;

export function setDebug(enabled: boolean): void {
  debugMode = enabled;
}

export function isDebug(): boolean {
  return debugMode;
}

export function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn("sab", msg);
}

export function resetWarnings(): void {
  warned.clear();
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(`[SAB] ${message}`);
    this.name = "ValidationError";
  }
}

/**
 * Human-readable reason a SAB header fails validation, or `null` when valid.
 * Distinguishes "not stamped yet" (readiness) from layout drift — callers
 * polling `isValid()` would otherwise wait forever on a mismatched buffer.
 */
export function describeHeaderValidation(
  u32: Uint32Array,
  magicIndex: number,
  versionIndex: number,
  expectedMagic: number,
  expectedVersion: number,
): string | null {
  const magic = u32[magicIndex];
  const version = u32[versionIndex];
  if (magic === 0) return "buffer not initialized (writer has not stamped the header)";
  if (magic !== expectedMagic) {
    return `bad magic 0x${magic.toString(16)} (expected 0x${expectedMagic.toString(16)})`;
  }
  if (version !== expectedVersion) {
    return `version mismatch (got ${version}, expected ${expectedVersion})`;
  }
  return null;
}

const TYPE_SIZES: Record<string, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  u32: 4,
  bool: 4,
};

export function typeSize(type: string): number {
  const size = TYPE_SIZES[type];
  if (size === undefined) {
    throw new ValidationError(`Unknown field type: "${type}"`);
  }
  return size;
}

export function alignUp(offset: number, alignment: number): number {
  return (offset + alignment - 1) & ~(alignment - 1);
}
