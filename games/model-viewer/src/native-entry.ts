// ============================================================================
// native-entry.ts — Bun-native entry point for model-viewer
//
// SDL window + wgpu-native via createNativeHost. The model-viewer has a bespoke
// render loop (not GameRenderer-based): main.tsx self-bootstraps on import,
// detects __nativeHost, skips the React mount, reuses the host's GPU device,
// and drives frames through the polyfilled requestAnimationFrame.
//
// Run: draft dev --native  (or: bun run src/native-entry.ts)
// ============================================================================

import { createNativeHost } from "@downdraft/platform-native";

const host = await createNativeHost({
  window: { title: "Model Viewer — Native", width: 1280, height: 720 },
});

try {
  await import("./main"); // bootstrap() runs on import
  await new Promise<void>((resolve) => {
    host.window.addEventListener("close", () => resolve());
  });
} finally {
  host.destroy();
}
