// ============================================================================
// secrets — binding for the optional `downdraft_secrets` cdylib (keyring).
//
// OS keychain access for tokens/credentials: secret-service on Linux,
// macOS Keychain, Windows Credential Manager. The library is optional — no
// session keyring → initNativeSecrets() returns null and games degrade
// gracefully (prompt each launch, or keep session-only tokens).
//
// Calls are synchronous FFI (ms-scale DBus/keychain IPC) — keep them off
// the render hot path; cache at load time.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen, ptr } from "../ffi/ffi-adapter";
import { resolveNativeLibrary } from "../ffi/lib-paths";

const log = createLogger("info");

const _dirname =
  typeof (globalThis as { __dirname?: string }).__dirname !== "undefined"
    ? (globalThis as { __dirname: string }).__dirname
    : join(fileURLToPath(import.meta.url), "..");

export interface SecretsStore {
  /** Fetch a credential — null when absent or unavailable. */
  get(service: string, account: string): string | null;
  /** Store a credential — false on backend failure. */
  set(service: string, account: string, secret: string): boolean;
  /** Delete a credential — false when absent or backend failed. */
  delete(service: string, account: string): boolean;
}

interface SecSymbols {
  dd_sec_set(service: string, account: string, secret: string): number;
  dd_sec_get(service: string, account: string, out: ptr, cap: number): number;
  dd_sec_del(service: string, account: string): number;
}

let active: SecretsStore | null | undefined;

/**
 * Load the keychain cdylib. Returns null when the library or a usable
 * credential backend is absent — callers must handle "no secrets".
 */
export function initNativeSecrets(): SecretsStore | null {
  if (active !== undefined) return active;

  const path = resolveNativeLibrary("downdraft_secrets", {
    optional: true,
    crateDir: join(_dirname, "..", "..", "native-secrets"),
    envVars: ["DD_SECRETS_LIB"],
    buildHint: 'run "cargo build -p downdraft-secrets" from the repo root',
  });
  if (!path) return (active = null);

  let lib: { symbols: SecSymbols };
  try {
    lib = dlopen(path, {
      dd_sec_set: { args: ["cstring", "cstring", "cstring"], returns: "i32" },
      dd_sec_get: { args: ["cstring", "cstring", "ptr", "usize"], returns: "i32" },
      dd_sec_del: { args: ["cstring", "cstring"], returns: "i32" },
    }) as unknown as { symbols: SecSymbols };
  } catch (e) {
    log.warn("secrets", `failed to load ${path}: ${e}`);
    return (active = null);
  }
  const sym = lib.symbols;
  const decoder = new TextDecoder();

  active = {
    get(service, account) {
      let cap = 4096;
      for (let i = 0; i < 3; i++) {
        const buf = new Uint8Array(cap);
        const rc = sym.dd_sec_get(service, account, ptr(buf.buffer as ArrayBuffer), cap);
        if (rc === 0) {
          const end = buf.indexOf(0);
          return decoder.decode(buf.subarray(0, end < 0 ? buf.length : end));
        }
        if (rc > 0) { cap = rc + 1; continue; } // grow and retry
        return null; // -1 args, -2 not found, -3 no backend, -4 internal
      }
      return null;
    },
    set(service, account, secret) {
      return sym.dd_sec_set(service, account, secret) === 0;
    },
    delete(service, account) {
      return sym.dd_sec_del(service, account) === 0;
    },
  };
  return active;
}
