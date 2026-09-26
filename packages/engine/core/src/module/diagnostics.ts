// ============================================================================
// DOWNDRAFT_STRICT — dev-mode diagnostics for the plugin system
//
// When STRICT is active (default in dev, off in prod), the plugin hosts
// validate the dependency graph at activation time and catch common footguns:
//   - duplicate `provide` of the same ResourceToken
//   - missing `requires` provider (a plugin needs a token nobody provides)
//   - brand mismatch (token type safety)
//   - leak detection (plugin provided resources / allocated SAB channels but
//     registered no dispose fns)
//
// Set `DOWNDRAFT_STRICT=0` to force-disable, `DOWNDRAFT_STRICT=1` to force-enable.
// ============================================================================

import type { ResourceToken } from "../ecs/resource";
import { createLogger } from "../util/logger";

const log = createLogger();

/** Error thrown when STRICT validation catches a footgun. */
export class DiagnosticError extends Error {
  readonly moduleName: string;
  readonly tokenKey: string;

  constructor(moduleName: string, tokenKey: string, message: string) {
    super(message);
    this.name = "DiagnosticError";
    this.moduleName = moduleName;
    this.tokenKey = tokenKey;
  }
}

function readEnv(): boolean {
  // Bun / Node
  const env = (globalThis as any).process?.env?.DOWNDRAFT_STRICT;
  if (env !== undefined) return env === "1";
  // Vite dev mode
  const meta = (globalThis as any).importMetaEnv;
  if (meta?.DEV === true) return true;
  return false;
}

let _strict: boolean | null = null;

/**
 * Whether STRICT diagnostics are active. Resolved lazily on first call
 * from the DOWNDRAFT_STRICT env var or Vite's import.meta.env.DEV.
 * Override for tests via `setStrict()`.
 */
export function isStrict(): boolean {
  if (_strict === null) _strict = readEnv();
  return _strict;
}

/** Override the STRICT flag (for tests). Pass `null` to reset to env-based. */
export function setStrict(value: boolean | null): void {
  _strict = value;
}

// ── Validation helpers ──

/**
 * Assert that a token is not already provided.
 * @param providers  Map of tokenKey → provider plugin name
 * @param token      The token being provided
 * @param moduleName The plugin attempting to provide it
 */
export function assertNoDuplicate(
  providers: Map<string, string>,
  token: ResourceToken<unknown>,
  moduleName: string,
): void {
  const existing = providers.get(token.key);
  if (existing !== undefined) {
    throw new DiagnosticError(
      moduleName,
      token.key,
      `Module "${moduleName}" provides "${token.key}" but it is already provided by "${existing}". ` +
        `Duplicate provides are not allowed — remove one, or use injectOptional to read without providing.`,
    );
  }
}

/**
 * Assert that a required token has a provider.
 * @param providers  Map of tokenKey → provider plugin name
 * @param token      The required token
 * @param moduleName The plugin that requires it
 */
export function assertRequired(
  providers: Map<string, string>,
  token: ResourceToken<unknown>,
  moduleName: string,
): void {
  if (!providers.has(token.key)) {
    throw new DiagnosticError(
      moduleName,
      token.key,
      `Module "${moduleName}" requires "${token.key}" which is not provided. ` +
        `Add a plugin that provides it, or declare it in the plugin's provides[] array.`,
    );
  }
}

/**
 * Warn about a potential resource leak: the plugin provided resources or
 * allocated SAB channels but registered no dispose fns.
 */
export function warnLeak(
  moduleName: string,
  details: { providedCount: number; sabCount: number; disposeFnCount: number },
): void {
  if (details.disposeFnCount > 0) return;
  const parts: string[] = [];
  if (details.providedCount > 0) parts.push(`${details.providedCount} resource(s)`);
  if (details.sabCount > 0) parts.push(`${details.sabCount} SAB channel(s)`);
  if (parts.length === 0) return;
  log.warn(
    "downdraft:diagnostics",
    `Module "${moduleName}" provided ${parts.join(" and ")} but registered no onDispose() cleanup. ` +
      `This may leak resources on unload.`,
  );
}
