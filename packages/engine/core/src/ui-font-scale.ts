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
 * Detect the system default font size and return a scale factor relative to
 * 16px. On the native host there is no CSS engine and no system font-size
 * preference to measure — always 1.
 */
export function detectSystemFontScale(): number {
  cachedSystemScale = 1;
  return 1;
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
