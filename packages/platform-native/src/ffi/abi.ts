// ============================================================================
// abi.ts — ABI version handshake for the platform cdylib
//
// The JS FFI specs and libdowndraft_platform ship in lockstep, but the
// library search path (lib-paths.ts) can pick up a stale .so — an old dev
// build in target/, a fetched artifact from a previous version, a packaged
// binary's bundled lib. Before the handshake existed, a stale lib surfaced
// as "Symbol X not found" at best and silent signature mismatches at worst.
//
// Every load of the platform library first binds dd_abi_version() alone and
// compares it to EXPECTED_PLATFORM_ABI. Mismatch (or a lib old enough to
// lack the export) throws immediately with an actionable message.
// ============================================================================

import { dlopen } from "./ffi-adapter";

/** Must equal DD_ABI_VERSION in native-rs/src/lib.rs. Bump together. */
export const EXPECTED_PLATFORM_ABI = 1;

const checked = new Set<string>();

/**
 * Assert that the platform library at `libPath` exports the ABI version this
 * JS build expects. Cached per path — subsequent calls are free.
 */
export function assertPlatformAbi(libPath: string): void {
  if (checked.has(libPath)) return;
  let version: number;
  try {
    const { symbols } = dlopen(libPath, {
      dd_abi_version: { args: [], returns: "u32" },
    });
    version = (symbols.dd_abi_version as () => number)();
  } catch (e) {
    throw new Error(
      `${libPath} does not export dd_abi_version — it predates ABI versioning ` +
        `and is incompatible with this build. Rebuild ("bun run build:native") ` +
        `or refetch ("bun run fetch:native"). Underlying error: ${(e as Error).message}`,
    );
  }
  checked.add(libPath);
  if (version !== EXPECTED_PLATFORM_ABI) {
    throw new Error(
      `${libPath} has ABI version ${version}, but this build expects ` +
        `${EXPECTED_PLATFORM_ABI}. Rebuild ("bun run build:native") or ` +
        `refetch ("bun run fetch:native") the matching native library.`,
    );
  }
}
