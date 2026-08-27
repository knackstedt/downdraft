import { resourceToken, type Plugin, type PluginContext } from "@downdraft/core";
import { EngineContext, MCPServer, type EngineContextFromGameOptions } from "@downdraft/mcp";

/** Token for the MCP server instance provided by the mcp plugin. */
export const McpServerTok = resourceToken<MCPServer>("mcp:server");

export function createMcpPlugin(opts: EngineContextFromGameOptions): Plugin {
  let server: MCPServer | null = null;

  return {
    name: "mcp",
    version: "0.1.0",
    requires: [],
    provides: [McpServerTok],
    register(ctx: PluginContext) {
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

