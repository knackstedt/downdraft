// ============================================================================
// RawInputModule — RendererModule wrapper for the pointer lock polyfill
// ============================================================================
// Games that use the module system can register this via moduleHost.useModules().
// Games that don't can just `import "@downdraft/module-raw-input/polyfill"`
// for the side effect (the polyfill installs itself on import).

import type { RendererModule } from "@downdraft/core";
import { installPointerLockPolyfill, uninstallPointerLockPolyfill } from "./polyfill";

export interface RawInputModuleOptions {
  /** Auto-install the polyfill on register. Default true. */
  autoInstall?: boolean;
}

export function createRawInputModule(_options: RawInputModuleOptions = {}): RendererModule {
  return {
    name: "raw-input",
    version: "1.0.0",
    register(ctx) {
      installPointerLockPolyfill();
      ctx.onDispose(() => {
        // The polyfill restores the original prototypes on uninstall.
        uninstallPointerLockPolyfill();
      });
    },
  };
}

// Re-export for convenience — games that use the module get it via register(),
// games that don't can import the side-effectful polyfill module directly.
export { installPointerLockPolyfill, uninstallPointerLockPolyfill } from "./polyfill";

// Module object (factory-less form for simple registration).
export const RawInputModule: RendererModule = {
  name: "raw-input",
  version: "1.0.0",
  register() {
    installPointerLockPolyfill();
  },
};
