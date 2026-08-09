// ============================================================================
// MCP HTTP transport — proxy mode (main process relays to renderer)
// ============================================================================

import { createLogger } from "@downdraft/core/util/logger";
import { McpHttpTransport, type McpProxyHandler } from "@downdraft/mcp/http-transport";
import { ipcMain } from "electron";
import type { DowndraftMcpConfig, MainContext } from "../types";

const log = createLogger("info");

const MCP_TIMEOUT_MS = parseInt(process.env.MCP_TIMEOUT_MS ?? "60000", 10);

export async function startMcpProxy(ctx: MainContext, config: DowndraftMcpConfig): Promise<void> {
  const proxyHandler: McpProxyHandler = async (request: { method: string; params?: Record<string, unknown> }) => {
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
          resolve({ error: result.error });
        } else {
          resolve(result.result);
        }
      });

      ctx.window!.webContents.send("mcp-request", {
        id: requestId,
        method: request.method,
        params: request.params,
      });
    });
  };

  try {
    const transport = new McpHttpTransport({ port: config.port, proxyHandler });
    await transport.start();
    log.info("MCP", `HTTP transport listening on port ${config.port} (timeout: ${MCP_TIMEOUT_MS}ms)`);
  } catch (e) {
    log.error("MCP", `Failed to start HTTP transport: ${(e as Error).message}`);
  }
}
