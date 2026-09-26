// ============================================================================
// shader-validator.ts — Centralized shader module creation with validation
// ============================================================================
//
// All GPU shader module creation in the engine should go through
// `createValidatedShaderModule()` (sync, background validation) or
// `createValidatedShaderModuleAsync()` (async, blocking validation for
// startup/bake-time). These helpers call `GPUShaderModule.getCompilationInfo()`
// after creation and surface errors as FATAL+throw and warnings as dedup'd
// warns, preventing malformed shaders from silently reaching the render
// pipeline and spamming the console with uncaptured-error messages.
//
// `installShaderValidationGuard(device)` monkey-patches `device.createShaderModule`
// so even direct calls (third-party code, missed call sites) route through
// validation. Install it once at device creation.
//
// Set `DOWNDRAFT_SHADER_VALIDATE=0` to disable validation (emergencies only).

import { createLogger } from "../util/logger";

const log = createLogger();

// ── Dedup state ──
// Prevents the same shader error/warning from being logged more than once.
// Cleared on HMR reload via `clearShaderValidationDedup()`.
const validatedDedup = new Set<string>();
let suppressedCount = 0;
const SUPPRESS_THRESHOLD = 50;

/** Clear the dedup set. Call on HMR reload so recompiled shaders get fresh validation. */
export function clearShaderValidationDedup(): void {
  validatedDedup.clear();
  suppressedCount = 0;
}

function dedupKey(label: string, message: string, lineNum: number): string {
  return `${label}:${lineNum}:${message.slice(0, 200)}`;
}

// ── Validation enabled flag ──
const validationEnabled = (() => {
  const env = (globalThis as any).process?.env ?? {};
  return env.DOWNDRAFT_SHADER_VALIDATE !== "0";
})();

/**
 * Process compilation info messages from a shader module.
 * Logs errors at FATAL level (and collects them for throwing), warnings at
 * warn level (deduplicated). Returns the array of error messages.
 */
function processCompilationInfo(
  module: GPUShaderModule,
  label: string,
): string[] {
  // If the module doesn't support getCompilationInfo (e.g. mock devices in
  // tests), skip validation gracefully.
  if (!validationEnabled || typeof module.getCompilationInfo !== "function") {
    return [];
  }

  let errors: string[] = [];
  // getCompilationInfo is async, but we want to process synchronously in the
  // background. We use .then() and collect errors into the closure.
  module
    .getCompilationInfo()
    .then((info: GPUCompilationInfo) => {
      for (let _i = 0, _it = info.messages, _n = _it.length; _i < _n; _i++) { const msg = _it[_i];
        const key = dedupKey(label, msg.message, msg.lineNum);
        if (validatedDedup.has(key)) {
          suppressedCount++;
          continue;
        }
        validatedDedup.add(key);

        const location = msg.lineNum > 0 ? ` (line ${msg.lineNum}:${msg.linePos})` : "";
        const fullMsg = `[${label}] ${msg.message}${location}`;

        if (msg.type === "error") {
          log.fatal("Shader", fullMsg);
          errors.push(fullMsg);
        } else if (msg.type === "warning") {
          log.warn("Shader", fullMsg);
        } else {
          log.debug("Shader", fullMsg);
        }
      }

      if (suppressedCount > 0 && suppressedCount % SUPPRESS_THRESHOLD === 0) {
        log.warn("Shader", `[${label}] ${suppressedCount} duplicate shader messages suppressed`);
      }
    })
    .catch(() => {
      // getCompilationInfo can reject on some implementations; ignore.
    });

  return errors;
}

/**
 * Create a validated shader module (sync, background validation).
 *
 * Returns the GPUShaderModule immediately. Validation runs asynchronously via
 * `getCompilationInfo()`. If errors are found, they are logged at FATAL level.
 * For startup-blocking validation, use `createValidatedShaderModuleAsync()`.
 *
 * This is the primary entry point for all shader creation in the engine.
 */
export function createValidatedShaderModule(
  device: GPUDevice,
  descriptor: GPUShaderModuleDescriptor,
): GPUShaderModule {
  const label = descriptor.label ?? "unnamed";
  const module = device.createShaderModule(descriptor);
  processCompilationInfo(module, label);
  return module;
}

/**
 * Create a validated shader module (async, blocking validation).
 *
 * Awaits `getCompilationInfo()` before returning. If compilation errors are
 * found, logs them at FATAL level and throws. Use this at startup/bake-time
 * where you want to block before the render loop begins.
 */
export async function createValidatedShaderModuleAsync(
  device: GPUDevice,
  descriptor: GPUShaderModuleDescriptor,
): Promise<GPUShaderModule> {
  const label = descriptor.label ?? "unnamed";
  const module = device.createShaderModule(descriptor);

  if (!validationEnabled || typeof module.getCompilationInfo !== "function") {
    return module;
  }

  try {
    const info = await module.getCompilationInfo();
    const errors: string[] = [];
    for (let _i = 0, _it = info.messages, _n = _it.length; _i < _n; _i++) { const msg = _it[_i];
      const key = dedupKey(label, msg.message, msg.lineNum);
      if (validatedDedup.has(key)) continue;
      validatedDedup.add(key);

      const location = msg.lineNum > 0 ? ` (line ${msg.lineNum}:${msg.linePos})` : "";
      const fullMsg = `[${label}] ${msg.message}${location}`;

      if (msg.type === "error") {
        log.fatal("Shader", fullMsg);
        errors.push(fullMsg);
      } else if (msg.type === "warning") {
        log.warn("Shader", fullMsg);
      } else {
        log.debug("Shader", fullMsg);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Shader compilation failed for "${label}":\n${errors.join("\n")}`,
      );
    }
  } catch (e) {
    // If getCompilationInfo itself throws, rethrow only if it's our error.
    if (e instanceof Error && e.message.includes("Shader compilation failed")) {
      throw e;
    }
    // Otherwise, getCompilationInfo rejected — skip validation.
  }

  return module;
}

// ── Enforcement: monkey-patch guard ──

/**
 * Install a guard on `device.createShaderModule` that routes all calls through
 * `createValidatedShaderModule()`. This ensures even direct calls (from
 * third-party code or call sites that weren't migrated) go through validation.
 *
 * Install once at device creation. The guard checks for `getCompilationInfo`
 * existence before using it; mock devices in tests are unaffected.
 */
export function installShaderValidationGuard(device: GPUDevice): void {
  if (!validationEnabled) return;

  // Avoid double-install.
  if ((device as any).__shaderValidationGuardInstalled) return;
  (device as any).__shaderValidationGuardInstalled = true;

  const originalCreateShaderModule = device.createShaderModule.bind(device);

  (device as any).createShaderModule = (
    descriptor: GPUShaderModuleDescriptor,
  ): GPUShaderModule => {
    const module = originalCreateShaderModule(descriptor);
    const label = descriptor.label ?? "unnamed";
    processCompilationInfo(module, label);
    return module;
  };
}
