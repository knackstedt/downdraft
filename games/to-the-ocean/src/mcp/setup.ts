// ============================================================================
// To The Ocean — renderer-side MCP automation harness setup
// Lightweight JSON-RPC handler wired to the main-process MCP HTTP proxy via
// the Electron preload bridge. Only registers automation tools; avoids pulling
// in the Node-only @downdraft/mcp server bundle in the renderer.
// ============================================================================

import { createFeatureLogMcpTool, createMcpHarness } from "@downdraft/app/renderer";
import type { SimWebWorker } from "../engine/sim-web-worker";
import type { WebGPURenderer } from "../engine/webgpu-renderer";
import { createAutomationTools } from "./automation-tools";

let setupDone = false;

export function setupTtolMcp(renderer: WebGPURenderer, worker: SimWebWorker): void {
  if (setupDone) return;
  setupDone = true;

  const tools = [
    ...createAutomationTools({
      renderer: () => renderer,
      worker: () => worker,
      store: () => {
        // Dynamic import to avoid circular dependency at module load time.
        // The game-store module imports components that import setup.ts
        // indirectly, causing a circular dep if we import at the top level.
        try {
          return (window as any).__gameStore ?? null;
        } catch {
          return null;
        }
      },
    }),
    createFeatureLogMcpTool(),
  ];

  createMcpHarness({
    serverName: "downdraft-ttol-automation",
    tools,
  });

  (window as any).__ttolMcp = { getToolNames: () => tools.map((t) => t.def.name) };
}
