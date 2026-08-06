// ============================================================================
// MCP HTTP transport — proxy mode (main process relays to renderer)
// ============================================================================

import { createLogger } from "@downdraft/core/util/logger";
import { McpHttpTransport, type McpProxyHandler } from "@downdraft/mcp/http-transport";
import { ipcMain } from "electron";
import type { DowndraftMcpConfig, MainContext } from "../types";

const log = createLogger("info");

export async function startMcpProxy(ctx: MainContext, config: DowndraftMcpConfig): Promise<void> {
  const proxyHandler: McpProxyHandler = async (request: { method: string; params?: Record<string, unknown> }) => {
    if (!ctx.window || ctx.window.isDestroyed()) {
      throw new Error("No renderer window available");
    }
    const requestId = Date.now() + Math.random();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners("mcp-response");
        reject(new Error("MCP request timed out"));
      }, 5000);

      ipcMain.once("mcp-response", (_e, result) => {
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
    log.info("MCP", `HTTP transport listening on port ${config.port}`);
  } catch (e) {
    log.error("MCP", `Failed to start HTTP transport: ${(e as Error).message}`);
  }
}
