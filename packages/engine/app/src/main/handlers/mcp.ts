// ============================================================================
// MCP HTTP transport — proxy mode (main process relays to renderer)
//
// Also supports main-process tools: tools passed via `mainTools` are handled
// locally (no renderer round-trip). Their defs are merged into `tools/list`
// alongside the renderer's tools, and `tools/call` dispatches locally when
// the requested tool name is in the main registry.
// ============================================================================

import type { ToolRegistration } from "@downdraft/engine/mcp";
import { McpHttpTransport, type McpProxyHandler } from "@downdraft/engine/mcp/http-transport";
import { createLogger } from "@downdraft/engine/util/logger";
import { ipcMain } from "electron";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { IPC } from "../../shared/messages";
import type { DowndraftMcpConfig, MainContext } from "../types";

const log = createLogger("info");

const MCP_TIMEOUT_MS = parseInt(process.env.MCP_TIMEOUT_MS ?? "60000", 10);

/**
 * Directory holding one PID file per running downdraft game instance.
 * Each file is named `<pid>` and contains the bound MCP HTTP port (string).
 * The stdio bridge reads this directory to auto-discover running instances;
 * dead-PID files are pruned on read. Best-effort cleanup on process exit.
 */
function mcpPortDir(): string {
  return join(homedir(), ".downdraft", "port");
}

/**
 * Write `~/.downdraft/port/<pid>` containing the bound port, so the stdio
 * bridge (and other local clients) can discover this instance. Also writes
 * `<pid>.token` holding the transport's bearer token — clients that opt into
 * auth (`mcp.requireAuth` / `MCP_AUTH=1`) read it and send the token via the
 * `Authorization: Bearer` or `X-Downdraft-Token` header. The port file format
 * stays a bare number for backward compatibility with existing bridges.
 * Returns a cleanup function that removes both files (best-effort).
 */
function writePidFile(port: number, token: string): () => void {
  const dir = mcpPortDir();
  const pidFile = join(dir, String(process.pid));
  const tokenFile = `${pidFile}.token`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(pidFile, String(port));
    writeFileSync(tokenFile, token, { mode: 0o600 });
  } catch (e) {
    log.warn("MCP", `Failed to write PID file ${pidFile}: ${(e as Error).message}`);
  }
  return () => {
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    try { unlinkSync(tokenFile); } catch { /* already gone */ }
  };
}

export async function startMcpProxy(
  ctx: MainContext,
  config: DowndraftMcpConfig,
  mainTools: ToolRegistration[] = [],
  artifactDir?: string,
): Promise<number> {
  const mainToolMap = new Map<string, ToolRegistration>();
  for (const t of mainTools) mainToolMap.set(t.def.name, t);

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

  const proxyHandler: McpProxyHandler = async (request: { method: string; params?: Record<string, unknown> }) => {
    const { method, params = {} } = request;

    // --- Main-process tool dispatch ---
    if (method === "tools/call") {
      const name = params.name as string;
      if (mainToolMap.has(name)) {
        const tool = mainToolMap.get(name)!;
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
      // Not a main tool — fall through to renderer.
    }

    // --- tools/list: merge main-process tool defs with renderer's ---
    if (method === "tools/list") {
      let rendererTools: any[] = [];
      try {
        const rendererResult = await forwardToRenderer({ method, params });
        // rendererResult is { tools: [...] } (from the harness tools/list handler)
        const r = rendererResult as { tools?: any[] } | { error?: any };
        if ("error" in r && r.error) {
          // Renderer failed — still return main tools.
          log.warn("MCP", `tools/list renderer error: ${JSON.stringify(r.error)} (returning main tools only)`);
        } else {
          rendererTools = (r as { tools?: any[] }).tools ?? [];
        }
      } catch (e) {
        // Renderer unavailable/timed out — still return main tools.
        log.warn("MCP", `tools/list renderer unavailable: ${(e as Error).message} (returning main tools only)`);
      }
      const mainDefs = mainTools.map((t) => ({
        name: t.def.name,
        description: t.def.description,
        inputSchema: t.def.inputSchema,
      }));
      // Main tools first, then renderer tools (renderer may override by name
      // if it intentionally re-declares one — but in practice names are disjoint).
      return { tools: [...mainDefs, ...rendererTools] };
    }

    // --- All other methods: forward to renderer ---
    return forwardToRenderer({ method, params });
  };

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
    const cleanupPidFile = writePidFile(actualPort, transport.getAuthToken());
    process.on("exit", cleanupPidFile);
    return actualPort;
  } catch (e) {
    log.error("MCP", `Failed to start HTTP transport: ${(e as Error).message}`);
    return 0;
  }
}
