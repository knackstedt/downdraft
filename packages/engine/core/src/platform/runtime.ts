// ============================================================================
// Runtime detection — capability-based, not runtime-name-based
//
// Every platform seam in the engine checks for capabilities, not runtime names.
// This file provides the few boolean helpers that are genuinely useful for
// dev/prod mode detection and logging, but the engine code should prefer
// direct capability checks (e.g. `navigator.gpu ?? globalThis.__nativeGpu`)
// over these helpers.
// ============================================================================

/** True when running under Bun (typeof Bun !== "undefined"). */
export const isBun: boolean = typeof (globalThis as any).Bun !== "undefined";

/** True when running under Electron (process.versions.electron exists). */
export const isElectron: boolean =
  typeof (globalThis as any).process !== "undefined" &&
  !!(globalThis as any).process?.versions?.electron;

/** True when running in a browser (window + document exist). */
export const isBrowser: boolean =
  typeof (globalThis as any).window !== "undefined" &&
  typeof (globalThis as any).document !== "undefined";

/**
 * Dev mode. Resolved from (in priority order):
 *   1. DOWNDRAFT_DEV=1 env var
 *   2. Vite's import.meta.env.DEV (injected at build time by Vite)
 *   3. NODE_ENV !== "production" (Bun / Node)
 *
 * In Bun-native mode, set DOWNDRAFT_DEV=1 or NODE_ENV=development.
 * In Vite mode, Vite injects import.meta.env.DEV automatically.
 */
export const isDev: boolean = (() => {
  // 1. Explicit env var
  const env = (globalThis as any).process?.env;
  if (env?.DOWNDRAFT_DEV === "1") return true;
  if (env?.DOWNDRAFT_DEV === "0") return false;
  // 2. Vite's import.meta.env.DEV — only available under Vite.
  //    In Bun, import.meta.env is process.env, so DEV is undefined (falsy).
  //    We use a try/catch because import.meta.env may not be accessible in
  //    all contexts (e.g. workers).
  try {
    const metaEnv = (import.meta as any).env;
    if (metaEnv?.DEV === true) return true;
  } catch {}
  // 3. NODE_ENV
  if (env?.NODE_ENV && env.NODE_ENV !== "production") return true;
  return false;
})();

/** Alias for {@link isDev} — used by engine seams as `isDevMode`. */
export const isDevMode: boolean = isDev;

/** True when HMR (hot module replacement) is available (Vite dev mode only). */
export const hasHMR: boolean = (() => {
  try {
    return !!(import.meta as any).hot;
  } catch {
    return false;
  }
})();
