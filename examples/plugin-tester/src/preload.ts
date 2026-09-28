// DORMANT — Electron/browser entry point; the example runs native-only now.
// ============================================================================
// Plugin Tester — Preload Entry
// ============================================================================

import { createDowndraftBridge } from "@downdraft/engine/app/preload";

createDowndraftBridge();
