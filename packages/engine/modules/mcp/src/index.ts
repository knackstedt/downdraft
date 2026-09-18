import { resourceToken, type Module, type ModuleContext } from "@downdraft/engine";
import { EngineContext, MCPServer, type EngineContextFromGameOptions } from "@downdraft/engine/mcp";

/** Token for the MCP server instance provided by the mcp plugin. */
export const McpServerTok = resourceToken<MCPServer>("mcp:server");

export function createMcpModule(opts: EngineContextFromGameOptions): Module {
  let server: MCPServer | null = null;

  return {
    name: "mcp",
    version: "0.1.0",
    requires: [],
    provides: [McpServerTok],
    register(ctx: ModuleContext) {
      const engineContext = EngineContext.fromGame(opts);
      server = new MCPServer({ engineContext });
      server.start();
      ctx.provide(McpServerTok, server);
      ctx.onDispose(() => server?.stop());
    },
  };
}

export { EngineContext, MCPServer };
export type { EngineContextFromGameOptions };

