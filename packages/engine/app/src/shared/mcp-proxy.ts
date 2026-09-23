// ============================================================================
// MCP proxy-handler factory — merges "host-side" tools with the renderer
// harness's tools behind a single JSON-RPC proxy handler.
//
// Electron-free: the caller provides `forwardToRenderer`. In Electron that's
// an IPC round-trip; on the native host it's a direct function call into the
// handler registered via `downdraft.onMcpRequest`.
// ============================================================================

import type { ToolRegistration } from "@downdraft/engine/mcp";
import type { McpProxyHandler } from "@downdraft/engine/mcp/http-transport";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

/**
 * Create a proxy handler that:
 *  - dispatches `tools/call` to host-side tools by name (no renderer hop),
 *  - merges host tool defs with renderer tool defs in `tools/list`,
 *  - forwards everything else to `forwardToRenderer`.
 */
export function createMcpProxyHandler(
  hostTools: ToolRegistration[],
  forwardToRenderer: (request: { method: string; params?: Record<string, unknown> }) => Promise<unknown>,
): McpProxyHandler {
  const hostToolMap = new Map<string, ToolRegistration>();
  for (const t of hostTools) hostToolMap.set(t.def.name, t);

  return async (request) => {
    const { method, params = {} } = request;

    // --- Host-side tool dispatch ---
    if (method === "tools/call") {
      const name = params.name as string;
      if (hostToolMap.has(name)) {
        const tool = hostToolMap.get(name)!;
        const args = (params.arguments as Record<string, unknown>) ?? {};
        try {
          return await tool.handler(args);
        } catch (e) {
          return {
            content: [{ type: "text", text: `Tool "${name}" failed: ${(e as Error).message}` }],
            isError: true,
          };
        }
      }
      // Not a host tool — fall through to renderer.
    }

    // --- tools/list: merge host tool defs with renderer's ---
    if (method === "tools/list") {
      let rendererTools: unknown[] = [];
      try {
        const rendererResult = await forwardToRenderer({ method, params });
        const r = rendererResult as { tools?: unknown[]; error?: unknown };
        if ("error" in r && r.error) {
          log.warn("MCP", `tools/list renderer error: ${JSON.stringify(r.error)} (returning host tools only)`);
        } else {
          rendererTools = (r as { tools?: unknown[] }).tools ?? [];
        }
      } catch (e) {
        log.warn("MCP", `tools/list renderer unavailable: ${(e as Error).message} (returning host tools only)`);
      }
      const hostDefs = hostTools.map((t) => ({
        name: t.def.name,
        description: t.def.description,
        inputSchema: t.def.inputSchema,
      }));
      // tools/call prefers host tools by name — the list must match that
      // dispatch order or clients see a tool that never actually runs (e.g.
      // the renderer's own capture_screenshot loses to the host's).
      const hostNames = new Set(hostToolMap.keys());
      const deduped = (rendererTools as Array<{ name?: string }>).filter(
        (t) => !t?.name || !hostNames.has(t.name),
      );
      return { tools: [...hostDefs, ...deduped] };
    }

    // --- All other methods: forward to renderer ---
    return forwardToRenderer({ method, params });
  };
}
