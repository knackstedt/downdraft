// ============================================================================
// To The Ocean — Preload Entry
// ============================================================================
//
// The default bridge (saves, display, osr, mcp, devtools, gpuInfo, console)
// is exposed automatically as window.downdraft. No extension needed yet.

import { createDowndraftBridge } from "@downdraft/app/preload";

createDowndraftBridge();
