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

// ---------------------------------------------------------------------------
// Host capability surface
//
// Runtime-name booleans (`isBun`, `isBrowser`) answer "what am I running
// on" — feature gates need "what can this host do". getHostCapabilities()
// answers that: it prefers the bridge-installed descriptor, then falls back
// to the `__nativeHost` marker (seeded by bun-preload before createNativeHost
// runs, so module-eval-time checks work), then to browser defaults.
// ---------------------------------------------------------------------------

export type HostRuntime = "native" | "browser";

export interface HostCapabilities {
  readonly runtime: HostRuntime;
  /** A real DOM compositor exists — DOM overlays, React roots, real
   *  elementFromPoint. False on native (the DOM there is a polyfill for
   *  canvas-shaped APIs, not a compositor). */
  readonly hasDom: boolean;
  /** OPFS persistence is reachable (navigator.storage.getDirectory). */
  readonly hasOpfs: boolean;
  /** The host can expose its wgpu device to multiple worker threads.
   *  True on native: wgpu handles are process-global and workers attach a
   *  non-owning view via shareDevice/attachSharedDevice. Intended for
   *  coarse-grained work — per-pass splitting loses to worker overhead. */
  readonly supportsMultiWorkerGpu: boolean;
}

export const NATIVE_HOST_CAPABILITIES: HostCapabilities = {
  runtime: "native",
  hasDom: false,
  hasOpfs: false,
  supportsMultiWorkerGpu: true,
};

const DOM_HOST_CAPABILITIES: HostCapabilities = {
  runtime: "browser",
  hasDom: true,
  hasOpfs: true,
  supportsMultiWorkerGpu: false,
};

/** The host's capability descriptor. Prefers `downdraft.capabilities` when a
 *  bridge is installed; otherwise detects the native host marker and finally
 *  assumes a plain browser/DOM host. */
export function getHostCapabilities(): HostCapabilities {
  const caps = (globalThis as { downdraft?: { capabilities?: HostCapabilities } })
    .downdraft?.capabilities;
  if (caps) return caps;
  if ((globalThis as { __nativeHost?: unknown }).__nativeHost) {
    return NATIVE_HOST_CAPABILITIES;
  }
  return DOM_HOST_CAPABILITIES;
}

/** The subset of the live native host object games legitimately reach for —
 *  primarily its GPU handles until the renderer gets an injected device
 *  (Phase 2 of the native re-architecture). */
export interface NativeHostHandle {
  device?: GPUDevice;
  adapter?: GPUAdapter;
  [key: string]: unknown;
}

/** The live native host object, or null when not on native — or when only
 *  the pre-boot `__nativeHost = true` marker exists (no device yet). Prefer
 *  `getHostCapabilities()` for feature gates; use this only when the host's
 *  concrete handles are genuinely needed. */
export function getNativeHost(): NativeHostHandle | null {
  const host = (globalThis as { __nativeHost?: unknown }).__nativeHost;
  return host && typeof host === "object" ? (host as NativeHostHandle) : null;
}
