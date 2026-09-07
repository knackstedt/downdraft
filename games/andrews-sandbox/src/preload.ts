// ============================================================================
// Andrew's Sandbox — Preload Entry
// ============================================================================
//
// The default bridge (saves, display, osr, mcp, devtools, gpuInfo, console,
// rawInput) is exposed automatically as window.downdraft. No extension needed.
//
// The rawInput bridge sub-object is available when features.rawInput is enabled
// in the main process config. The pointer lock polyfill (imported in main.tsx)
// uses it to override the browser's Pointer Lock API with native raw mouse
// capture, bypassing Chrome's ESC-exits-pointer-lock behavior.

import { createDowndraftBridge } from "@downdraft/app/preload";

createDowndraftBridge();
