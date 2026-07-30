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
  console.warn(`[SAB] ${msg}`);
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
