// ============================================================================
// native-wgsl.ts — Build-time WGSL validation via naga (in-process)
//
// Replaces the external Tint CLI: `dd_wgsl_validate` in libdowndraft_platform
// runs naga's WGSL frontend + validator — the exact same checks wgpu applies
// when a shader module is created at runtime, with no subprocess or temp
// files. Loading is lazy: dlopen happens on the first validateWgsl() call.
// ============================================================================

import { dlopen } from "../ffi/ffi-adapter";
import { resolvePlatformLibrary } from "../ffi/lib-paths";

export interface WgslValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

type WgslValidateFn = (src: Buffer, srcLen: number, out: Buffer | null, outCap: number) => number;
let _validate: WgslValidateFn | null | undefined;

function getValidator(): WgslValidateFn | null {
  if (_validate !== undefined) return _validate;
  _validate = null;
  try {
    const libPath = resolvePlatformLibrary();
    const lib = dlopen(libPath, {
      dd_wgsl_validate: { args: ["ptr", "u32", "ptr", "u32"], returns: "u32" },
    });
    _validate = lib.symbols.dd_wgsl_validate as unknown as WgslValidateFn;
  } catch {
    _validate = null;
  }
  return _validate;
}

/**
 * Validate WGSL source with naga. Returns `null` when the native validator
 * is unavailable (platform library missing) — callers should treat that as
 * "validation disabled", the same as a missing Tint binary before.
 */
export function validateWgslNative(
  source: string,
  _filePath?: string,
): WgslValidationResult | null {
  const validate = getValidator();
  if (!validate) return null;

  const src = Buffer.from(source, "utf-8");
  const needed = validate(src, src.length, null, 0);
  if (needed === 0) return { ok: true, errors: [], warnings: [] };

  const buf = Buffer.alloc(needed);
  validate(src, src.length, buf, needed);
  return { ok: false, errors: [buf.toString("utf-8").trim()], warnings: [] };
}
