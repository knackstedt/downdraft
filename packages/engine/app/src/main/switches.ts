// ============================================================================
// Chrome/GPU command-line switch presets
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

export type Switch = [name: string, value?: string];

/**
 * Default WebGPU + GPU acceleration switches for the Downdraft engine.
 * Includes platform-specific Vulkan (Linux) and D3D12 (Windows) flags.
 *
 * Set `DOWNDRAFT_GPU=swiftshader` in the environment to force Chromium's
 * software Vulkan backend (for headless CI / testing without a GPU).
 *
 * Returns an array of `[name, value?]` pairs to be applied via
 * `app.commandLine.appendSwitch(name, value?)`.
 */
export function webGpuSwitches(): Switch[] {
  const useSwiftshader = process.env.DOWNDRAFT_GPU === "swiftshader";

  const switches: Switch[] = [
    ["enable-unsafe-webgpu"],
    ["ignore-gpu-blocklist"],
    ["enable-gpu-rasterization"],
    ["enable-zero-copy"],
    ["enable-accelerated-video-decode"],
    // --expose-gc: lets the gc-controller trigger manual GC passes.
    // --max-old-space-size=8192: raises the V8 old-generation heap cap from
    // the default ~4 GB to 8 GB. The default cap is exactly where the OOM
    // crashed (4 GB), and a game with many props + contacts + WebGPU resources
    // can legitimately exceed it before GC catches up.
    ["js-flags", "--expose-gc --max-old-space-size=8192"],
    // Disable Chromium's pointer-lock rate limiter. The engine re-locks the
    // pointer when closing the ESC menu (via exitPointerLock + requestPointerLock),
    // which Chromium's abuse-prevention would otherwise reject as "too many
    // locks in a short window". This is a single-user desktop app, not a web
    // page, so the abuse scenario doesn't apply.
    ["disable-features", "RateLimitPointerLockRequests"],
  ];

  if (useSwiftshader) {
    log.info("switches", "Using SwiftShader Vulkan for software WebGPU rendering");
    switches.push(
      ["enable-unsafe-swiftshader"],
      ["use-vulkan", "swiftshader"],
      ["use-angle", "swiftshader"],
      ["use-webgpu-adapter", "swiftshader"],
    );
    if (process.platform === "linux") {
      switches.push(
        ["enable-features", "Vulkan,UseSkiaRenderer"],
        ["disable-vulkan-surface"],
        ["ozone-platform-hint", "auto"],
        ["disable-gpu-sandbox"],
      );
    }
  } else if (process.platform === "linux") {
    log.info("switches", "Using hardware GPU for WebGPU rendering");
    // Force NVIDIA Vulkan ICD to prevent llvmpipe (software) fallback
    process.env.VK_ICD_FILENAMES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
    switches.push(
      ["enable-features", "Vulkan,VaapiVideoDecoder,VaapiVideoEncoder"],
      ["ozone-platform-hint", "auto"],
      // Disable GPU sandbox — can interfere with GPU shared texture handle passing on some NVIDIA drivers
      ["disable-gpu-sandbox"],
    );
  } else if (process.platform === "win32") {
    log.info("switches", "Using hardware GPU for WebGPU rendering");
    // Windows uses D3D12 backend for WebGPU; enable hardware-accelerated decoding
    switches.push(["enable-features", "D3D12VideoDecoder"]);
  }

  return switches;
}

/**
 * Apply an array of switches to the Electron app command line.
 * If the same switch name appears multiple times, their values are merged
 * (comma-joined for `enable-features`/`disable-features`, last-wins otherwise).
 */
export function applySwitches(app: { commandLine: { appendSwitch: (name: string, value?: string) => void } }, switches: Switch[]): void {
  const merged = new Map<string, string | undefined>();
  switches.forEach(([name, value]) => {
    if (value !== undefined && merged.has(name) && merged.get(name) !== undefined) {
      const prev = merged.get(name)!;
      // For feature lists, merge comma-separated values instead of overwriting.
      if (name === "enable-features" || name === "disable-features") {
        const set = new Set(prev.split(",").filter(Boolean));
        for (const f of value.split(",")) if (f) set.add(f);
        merged.set(name, Array.from(set).join(","));
      } else {
        merged.set(name, value);
      }
    } else {
      merged.set(name, value);
    }
  });
  for (const [name, value] of merged.entries()) {
    app.commandLine.appendSwitch(name, value);
  }
}
