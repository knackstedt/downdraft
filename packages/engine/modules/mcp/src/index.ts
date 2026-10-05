import { resourceToken, type Module, type ModuleContext } from "@downdraft/engine";
import { EngineContext, MCPServer, type EngineContextFromGameOptions } from "@downdraft/engine/mcp";
import type { McpHttpTransport } from "@downdraft/engine/mcp/http-transport";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

/** Token for the MCP server instance provided by the mcp plugin. */
export const McpServerTok = resourceToken<MCPServer>("mcp:server");

export interface McpModuleOptions extends EngineContextFromGameOptions {
  /**
   * Transport for the MCP JSON-RPC surface:
   *  - "stdio" (default): newline-delimited JSON-RPC on the process's own
   *    stdin/stdout — classic spawn-as-an-MCP-process mode.
   *  - "http": `McpHttpTransport` direct mode on 127.0.0.1 — a second loopback
   *    endpoint alongside the game's automation endpoint, advertised via
   *    `~/.downdraft/port/<pid>.editor` and reached with `draft mcp --editor`
   *    or `GameClient.connect({ endpoint: "editor" })`.
   */
  transport?: "stdio" | "http";
  /** HTTP port for transport:"http" (0 = ephemeral, the default).
   *  MCP_EDITOR_PORT env overrides when `port` is unset. */
  port?: number;
  /** Require the bearer token on HTTP requests (default: MCP_AUTH=1 env). */
  requireAuth?: boolean;
  /** Root dir for GET /mcp/artifact/<path> downloads (transport:"http"). */
  artifactDir?: string;
  /** Write `~/.downdraft/port/<pid>.editor` (+ `.editor.token`) so PID-file
   *  discovery finds this endpoint. Default true in http mode. */
  advertise?: boolean;
}

export function createMcpModule(opts: McpModuleOptions): Module {
  let server: MCPServer | null = null;

  return {
    name: "mcp",
    version: "0.1.0",
    requires: [],
    provides: [McpServerTok],
    register(ctx: ModuleContext) {
      const engineContext = EngineContext.fromGame(opts);
      server = new MCPServer({ engineContext });
      ctx.provide(McpServerTok, server);

      if (opts.transport !== "http") {
        server.start();
        ctx.onDispose(() => server?.stop());
        return;
      }

      // HTTP transport — node:http and the PID-file dir are Node APIs, so
      // they're dynamic-imported (keeps this module loadable in non-node
      // contexts; same convention as createNodeFs in the editor module).
      let disposed = false;
      let transport: McpHttpTransport | null = null;
      let removePidFile: (() => void) | null = null;
      void (async () => {
        const [{ McpHttpTransport }, { writeMcpPidFile }] = await Promise.all([
          import("@downdraft/engine/mcp/http-transport"),
          import("@downdraft/engine/app/shared/mcp-discovery"),
        ]);
        if (disposed || !server) return;
        transport = new McpHttpTransport({
          mcpServer: server,
          port: opts.port ?? (Number(process.env.MCP_EDITOR_PORT) || 0),
          requireAuth: opts.requireAuth,
          artifactDir: opts.artifactDir,
        });
        await transport.start();
        if (disposed) {
          await transport.stop();
          return;
        }
        if (opts.advertise !== false) {
          removePidFile = writeMcpPidFile(transport.getPort(), transport.getAuthToken(), ".editor");
        }
        log.info("mcp", `Editor MCP server listening on 127.0.0.1:${transport.getPort()}`);
      })().catch((e) => {
        log.warn("mcp", `Editor MCP HTTP endpoint failed to start: ${(e as Error).message}`);
      });
      ctx.onDispose(() => {
        disposed = true;
        removePidFile?.();
        void transport?.stop();
      });
    },
  };
}

export { EngineContext, MCPServer };
export type { EngineContextFromGameOptions };

