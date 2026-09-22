// ============================================================================
// native-mcp.ts — in-process MCP server for the native host
//
// Electron's MCP path is: HTTP transport → IPC → renderer harness. On native
// there is no second process: the harness handler registered via
// `downdraft.onMcpRequest` is called directly, and host tools (screenshot,
// process snapshot, display info, quit) execute locally.
// ============================================================================

import { writeMcpPidFile } from "@downdraft/engine/app/shared/mcp-discovery";
import { createMcpProxyHandler } from "@downdraft/engine/app/shared/mcp-proxy";
import type { DowndraftBridgeAPI, McpRequest, McpResponse } from "@downdraft/engine/app/shared/types";
import type { ToolRegistration } from "@downdraft/engine/mcp";
import { McpHttpTransport } from "@downdraft/engine/mcp/http-transport";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

export interface NativeMcpOptions {
  /** Fixed port (default: ephemeral). */
  port?: number;
  requireAuth?: boolean;
  /** Root for GET /mcp/artifact/<path> downloads. */
  artifactDir?: string;
  /** Extra host-side tools, merged into tools/list ahead of renderer tools. */
  extraHostTools?: ToolRegistration[];
}

export interface NativeMcpServer {
  port: number;
  stop(): Promise<void>;
}

/**
 * Standard host-side tools, mirroring the Electron main-process tool set:
 * capture_screenshot, process_snapshot, display_info, quit.
 */
export function createNativeHostTools(bridge: DowndraftBridgeAPI): ToolRegistration[] {
  return [
    {
      def: {
        name: "capture_screenshot",
        description: "Capture the native window's GPU surface as a PNG (base64 image content).",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const png = await bridge.capturePage();
        if (!png) throw new Error("capturePage returned null (no surface texture available)");
        // Text part mirrors the renderer-harness tool's metadata so the e2e
        // harness's captureAndSaveScreenshot works unchanged. The native
        // surface IS the full page (UI is composited into the swapchain).
        // Dims come from the PNG IHDR — the bridge API doesn't expose them.
        const dv = new DataView(png);
        const meta = { width: dv.getUint32(16), height: dv.getUint32(20), fullPage: true };
        return {
          content: [
            { type: "text", text: JSON.stringify(meta, null, 2) },
            { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
          ],
        };
      },
    },
    {
      def: {
        name: "process_snapshot",
        description: "Capture native-process memory and CPU usage.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => ({
        content: [{ type: "text", text: JSON.stringify(await bridge.processSnapshot(), null, 2) }],
      }),
    },
    {
      def: {
        name: "display_info",
        description: "Get display information (refresh rate).",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => ({
        content: [{ type: "text", text: JSON.stringify(await bridge.getDisplayInfo()) }],
      }),
    },
    {
      def: {
        name: "quit",
        description: "Request the game window to close.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        await bridge.quit();
        return { content: [{ type: "text", text: "Quit requested" }] };
      },
    },
  ];
}

/**
 * Start the MCP HTTP server bound to loopback. The proxy handler forwards
 * renderer-targeted methods straight into the handler the game's
 * `createMcpHarness` registered via `downdraft.onMcpRequest` — no IPC.
 */
export async function startNativeMcpServer(
  bridge: DowndraftBridgeAPI,
  opts: NativeMcpOptions = {},
): Promise<NativeMcpServer> {
  const forwardToHarness = async (request: { method: string; params?: Record<string, unknown> }): Promise<unknown> => {
    const handler = (globalThis as Record<string, unknown>).__ddMcpHandler as
      | ((req: McpRequest) => Promise<McpResponse>)
      | undefined;
    if (!handler) {
      throw new Error("No MCP harness registered yet (game's createMcpHarness hasn't run)");
    }
    const res = await handler({ id: Date.now() + Math.random(), method: request.method, params: request.params });
    if (res.error) {
      throw new Error(res.error.message ?? `Renderer error ${res.error.code ?? ""}`);
    }
    return res.result;
  };

  const hostTools = [...createNativeHostTools(bridge), ...(opts.extraHostTools ?? [])];
  const proxyHandler = createMcpProxyHandler(hostTools, forwardToHarness);

  const transport = new McpHttpTransport({
    // MCP_PORT lets the e2e harness (`draft test --runtime=native`) pin the
    // port the same way it does for the Electron transport.
    port: opts.port ?? (Number(process.env.MCP_PORT) || 0),
    requireAuth: opts.requireAuth,
    artifactDir: opts.artifactDir,
    proxyHandler,
  });
  await transport.start();
  const port = transport.getPort();
  const removePidFile = writeMcpPidFile(port, transport.getAuthToken());

  const cleanup = () => {
    removePidFile();
    void transport.stop().catch(() => {});
  };
  process.on("exit", () => { try { removePidFile(); } catch { /* gone */ } });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  log.info("mcp", `Native MCP server listening on 127.0.0.1:${port}${transport.getAuthToken() ? " (auth required)" : ""}`);
  return { port, stop: async () => transport.stop() };
}
