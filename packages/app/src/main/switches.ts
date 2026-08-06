// ============================================================================
// Chrome/GPU command-line switch presets
// ============================================================================

export type Switch = [name: string, value?: string];

/**
 * Default WebGPU + GPU acceleration switches for the Downdraft engine.
 * Includes platform-specific Vulkan (Linux) and D3D12 (Windows) flags.
 *
 * Returns an array of `[name, value?]` pairs to be applied via
 * `app.commandLine.appendSwitch(name, value?)`.
 */
export function webGpuSwitches(): Switch[] {
  const switches: Switch[] = [
    ["enable-unsafe-webgpu"],
    ["ignore-gpu-blocklist"],
    ["enable-gpu-rasterization"],
    ["enable-zero-copy"],
    ["enable-accelerated-video-decode"],
    ["js-flags", "--expose-gc"],
  ];

  if (process.platform === "linux") {
    // Force NVIDIA Vulkan ICD to prevent llvmpipe (software) fallback
    process.env.VK_ICD_FILENAMES = "/usr/share/vulkan/icd.d/nvidia_icd.json";
    switches.push(
      ["enable-features", "Vulkan,VaapiVideoDecoder,VaapiVideoEncoder"],
      ["ozone-platform-hint", "auto"],
      // Disable GPU sandbox — can interfere with GPU shared texture handle passing on some NVIDIA drivers
      ["disable-gpu-sandbox"],
    );
  } else if (process.platform === "win32") {
    // Windows uses D3D12 backend for WebGPU; enable hardware-accelerated decoding
    switches.push(["enable-features", "D3D12VideoDecoder"]);
  }

  return switches;
}

/**
 * Apply an array of switches to the Electron app command line.
 */
export function applySwitches(app: { commandLine: { appendSwitch: (name: string, value?: string) => void } }, switches: Switch[]): void {
  for (const [name, value] of switches) {
    app.commandLine.appendSwitch(name, value);
  }
}
