// ============================================================================
// System font-size detection + font-scale utilities.
//
// detectSystemFontScale() measures the browser's default font size (1rem in
// CSS pixels) and returns a scale factor relative to the 16px browser default.
// If the user has increased their system/browser font size (e.g. for
// accessibility), the returned scale is > 1.0. It is clamped to a minimum of
// 1.0 — we never scale text down below the engine's designed sizes.
//
// The detected scale is used as the default font scale for game UI. Games
// can let the user increase it further via a settings control; the effective
// scale is `max(systemFontScale, userFontScale)`.
// ============================================================================

let cachedSystemScale: number | null = null;

/**
 * Detect the system/browser default font size and return a scale factor
 * relative to 16px (the browser default). Always returns >= 1.0.
 *
 * Example: if the user set their browser default font to 20px, this returns
 * 1.25. If the browser default is 16px (normal), this returns 1.0.
 *
 * Must be called on the main thread (requires `document`).
 */
export function detectSystemFontScale(): number {
  if (cachedSystemScale !== null) return cachedSystemScale;
  // On the native host the document is a canvas-compat facade — there is no
  // CSS engine and no getComputedStyle, so there is no "system font size"
  // to measure. Always 1.
  if (typeof document === "undefined" || !document.body || typeof getComputedStyle !== "function") {
    cachedSystemScale = 1;
    return 1;
  }

  const el = document.createElement("div");
  el.style.fontSize = "1rem";
  el.style.position = "absolute";
  el.style.visibility = "hidden";
  el.style.lineHeight = "0";
  el.style.margin = "0";
  el.style.padding = "0";
  document.body.appendChild(el);

  let scale = 1;
  try {
    const size = parseFloat(getComputedStyle(el).fontSize);
    // 16px is the browser default. Only scale up (never down).
    scale = size > 0 ? Math.max(1, size / 16) : 1;
  } catch {
    scale = 1;
  } finally {
    document.body.removeChild(el);
  }

  cachedSystemScale = scale;
  return scale;
}

/**
 * Cached accessor for the system font scale. After the first call to
 * detectSystemFontScale(), subsequent calls return the cached value.
 */
export function getSystemFontScale(): number {
  return cachedSystemScale ?? detectSystemFontScale();
}

/**
 * localStorage key for the user's font-scale preference.
 * Stored as a number (e.g. 1.25). Games read this on startup to set their
 * UI font scale (`setUIFontScale`).
 */
export const FONT_SCALE_STORAGE_KEY = "dd:fontScale";

/**
 * Load the user's font-scale preference from localStorage. Returns null if
 * not set (the caller should fall back to the system-detected scale).
 */
export function loadUserFontScale(): number | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(FONT_SCALE_STORAGE_KEY);
    if (raw === null) return null;
    const val = parseFloat(raw);
    return isNaN(val) ? null : Math.max(1, val);
  } catch {
    return null;
  }
}

/**
 * Save the user's font-scale preference to localStorage.
 */
export function saveUserFontScale(scale: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(Math.max(1, scale)));
  } catch {
    // Ignore storage errors (private mode, quota, etc.)
  }
}

/**
 * Compute the effective font scale: the maximum of the system-detected scale
 * and the user's preference. This ensures the system accessibility setting is
 * always respected, even if the user hasn't explicitly set a preference.
 */
export function getEffectiveFontScale(userScale: number | null): number {
  const system = getSystemFontScale();
  if (userScale === null) return system;
  return Math.max(system, userScale);
}
