// ============================================================================
// native-entry.ts — Bun-native entry point for the visual test bench
//
// SDL window + wgpu-native via createNativeHost. The bench has a bespoke render
// loop (not GameRenderer-based): main.tsx self-bootstraps on import, detects
// the missing DOM overlay, skips the React mount, and drives frames through
// the polyfilled requestAnimationFrame. Test modules self-register via the
// filesystem fallback in tests/index.ts (import.meta.glob is Vite-only).
//
// Run: draft dev --native  (or: bun run src/native-entry.ts)
// ============================================================================

import { createNativeHost } from "@downdraft/platform-native";

const host = await createNativeHost({
  window: { title: "Visual Test Bench — Native", width: 1280, height: 720 },
});

try {
  await import("./main"); // main() runs on import
  await new Promise<void>((resolve) => {
    host.window.addEventListener("close", () => resolve());
  });
} finally {
  host.destroy();
}
