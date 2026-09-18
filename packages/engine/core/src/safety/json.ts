/**
 * Keys that are blocked to prevent prototype pollution.
 */
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Recursively sanitizes a parsed JSON object:
 * - Resets any prototype that was set via `__proto__` pollution
 * - Removes own properties named `__proto__`, `constructor`, `prototype`
 * - Recurses into nested objects and arrays
 */
function deepSanitize<T>(obj: T): T {
  if (typeof obj !== "object" || obj === null) return obj;

  if (Array.isArray(obj)) {
    const arr = obj as unknown[];
    for (let i = 0; i < arr.length; i++) {
      arr[i] = deepSanitize(arr[i]);
    }
    return obj;
  }

  // Reset prototype in case __proto__ pollution occurred during JSON.parse
  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) {
    Object.setPrototypeOf(obj, Object.prototype);
  }

  const record = obj as Record<string, unknown>;

  // Check for own properties named with blocked keys (including non-enumerable)
  for (const key of Object.getOwnPropertyNames(record)) {
    if (BLOCKED_KEYS.has(key)) {
      delete record[key];
    }
  }

  // Recurse into remaining enumerable keys
  for (const key of Object.keys(record)) {
    record[key] = deepSanitize(record[key]);
  }

  return obj;
}

/**
 * Parses JSON safely, preventing prototype pollution (`__proto__`,
 * `constructor`, `prototype` keys are stripped).
 *
 * Throws on invalid JSON (same as `JSON.parse`).
 */
export function safeJsonParse<T>(text: string): T {
  const parsed = JSON.parse(text);
  return deepSanitize(parsed) as T;
}

/**
 * Parses JSON safely and validates the result with a type guard.
 * Returns `null` if parsing fails or validation rejects the result.
 */
export function safeJsonParseWithSchema<T>(
  text: string,
  validate: (obj: unknown) => obj is T,
): T | null {
  try {
    const parsed = safeJsonParse<unknown>(text);
    if (validate(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Recursively removes prototype-polluting keys from an already-parsed object.
 * Useful for sanitizing objects received from untrusted sources.
 */
export function sanitizeObject<T>(obj: T): T {
  return deepSanitize(obj);
}
