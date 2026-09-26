// ============================================================================
// auto-backend.ts — runtime-aware RapierPhysicsBackend construction.
//
// Under the native Bun runtime, physics runs on the Rust cdylib via
// RapierFfiBackend (batched FFI ABI, no WASM↔JS crossings in the hot loop).
// Everywhere else (Electron renderer, web) it falls back to the WASM bundle.
//
// The FFI module is loaded via dynamic import so @downdraft/platform-native
// never enters browser bundles. The @vite-ignore + variable specifier keeps
// Vite from trying to bundle the native path into web builds.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { RapierPhysicsBackend } from "./backend";

const log = createLogger("info");

/** True when running inside the native Bun runtime (main thread or worker). */
export function isNativeRuntime(): boolean {
  return typeof (globalThis as any).Bun !== "undefined";
}

let ffiCtor: (new () => RapierPhysicsBackend) | null | undefined;

async function probeFfi(): Promise<(new () => RapierPhysicsBackend) | null | undefined> {
  if (ffiCtor !== undefined) return ffiCtor;
  if (!isNativeRuntime()) return (ffiCtor = null);
  try {
    // @vite-ignore — native-only module; must not be bundled into web builds.
    const spec = "@downdraft/engine/libraries/physics-rapier/ffi-backend";
    const mod = await import(spec);
    // Probe now (the result is cached) so a missing/unbuilt .so falls back to
    // WASM here instead of throwing later in backend.init().
    await mod.loadFfiPhysicsLib();
    ffiCtor = mod.RapierFfiBackend;
    log.info("physics", "using native Rapier FFI backend");
  } catch (err) {
    log.warn("physics", `native FFI lib unavailable, falling back to WASM: ${err}`);
    ffiCtor = null;
  }
  return ffiCtor;
}

/**
 * Create a RapierPhysicsBackend with the best available PhysicsLib for this
 * runtime — native cdylib under Bun (RapierFfiBackend), WASM elsewhere.
 * Call `init()` as usual.
 */
export async function createRapierBackend(): Promise<RapierPhysicsBackend> {
  const ctor = await probeFfi();
  return ctor ? new ctor() : new RapierPhysicsBackend();
}
