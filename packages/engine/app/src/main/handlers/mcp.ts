// ============================================================================
// MCP HTTP transport — proxy mode (main process relays to renderer)
//
// Also supports main-process tools: tools passed via `mainTools` are handled
// locally (no renderer round-trip). Their defs are merged into `tools/list`
// alongside the renderer's tools, and `tools/call` dispatches locally when
// the requested tool name is in the main registry.
// ============================================================================

import type { ToolRegistration } from "@downdraft/engine/mcp";
import { McpHttpTransport } from "@downdraft/engine/mcp/http-transport";
import { createLogger } from "@downdraft/engine/util/logger";
import { ipcMain } from "electron";
import { writeMcpPidFile } from "../../shared/mcp-discovery";
import { createMcpProxyHandler } from "../../shared/mcp-proxy";
import { IPC } from "../../shared/messages";
import type { DowndraftMcpConfig, MainContext } from "../types";

const log = createLogger("info");

const MCP_TIMEOUT_MS = parseInt(process.env.MCP_TIMEOUT_MS ?? "60000", 10);

export async function startMcpProxy(
  ctx: MainContext,
  config: DowndraftMcpConfig,
  mainTools: ToolRegistration[] = [],
  artifactDir?: string,
): Promise<number> {
  const forwardToRenderer = (request: { method: string; params?: Record<string, unknown> }): Promise<unknown> => {
    if (!ctx.window || ctx.window.isDestroyed()) {
      throw new Error("No renderer window available");
    }
    const requestId = Date.now() + Math.random();
    const responseChannel = `mcp-response-${requestId}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners(responseChannel);
        reject(new Error(`MCP request timed out after ${MCP_TIMEOUT_MS}ms`));
      }, MCP_TIMEOUT_MS);

      ipcMain.once(responseChannel, (_e, result) => {
        clearTimeout(timeout);
        if (result.error) {
          // Surface renderer errors as a rejected promise so they become
          // JSON-RPC errors — resolving {error} would look like a successful
          // tool result with no content to HTTP clients.
          reject(new Error(result.error.message ?? `Renderer error ${result.error.code ?? ""}`));
        } else {
          resolve(result.result);
        }
      });

      ctx.window!.webContents.send(IPC.MCP_REQUEST, {
        id: requestId,
        method: request.method,
        params: request.params,
      });
    });
  };

  const proxyHandler = createMcpProxyHandler(mainTools, forwardToRenderer);

  try {
    const transport = new McpHttpTransport({
      port: config.port ?? 0,
      proxyHandler,
      artifactDir,
      requireAuth: config.requireAuth,
    });
    await transport.start();
    const actualPort = transport.getPort();
    const ephemeral = (config.port ?? 0) === 0;
    log.info(
      "MCP",
      `HTTP transport listening on port ${actualPort} (${ephemeral ? "ephemeral" : "fixed"}, timeout: ${MCP_TIMEOUT_MS}ms${mainTools.length ? `, ${mainTools.length} main tools` : ""})`,
    );
    // Advertise this instance via a PID file so the stdio bridge can
    // auto-discover it. Register best-effort cleanup on process exit.
    const cleanupPidFile = writeMcpPidFile(actualPort, transport.getAuthToken());
    process.on("exit", cleanupPidFile);
    return actualPort;
  } catch (e) {
    log.error("MCP", `Failed to start HTTP transport: ${(e as Error).message}`);
    return 0;
  }
}
