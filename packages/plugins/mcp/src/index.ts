import type { Plugin, PluginContext } from "@downdraft/core";
import { MCPServer, EngineContext, type EngineContextFromGameOptions } from "@downdraft/mcp";

export function createMcpPlugin(opts: EngineContextFromGameOptions): Plugin {
  let server: MCPServer | null = null;

  return {
    name: "mcp",
    version: "0.1.0",
    dependencies: [],
    register(ctx: PluginContext) {
      const engineContext = EngineContext.fromGame(opts);
      server = new MCPServer({ engineContext });
      server.start();
      ctx.onDispose(() => server?.stop());
    },
  };
}

export { MCPServer, EngineContext };
export type { EngineContextFromGameOptions };
