import type { World } from "@downdraft/core";

export class MCPServer {
  private world: World | null = null;
  private tools: Map<string, (params: unknown) => Promise<unknown>> = new Map();

  attachWorld(world: World): void {
    this.world = world;
  }

  registerTool(name: string, handler: (params: unknown) => Promise<unknown>): void {
    this.tools.set(name, handler);
  }

  async callTool(name: string, params: unknown): Promise<unknown> {
    const handler = this.tools.get(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return handler(params);
  }

  listTools(): string[] {
    return [...this.tools.keys()];
  }

  start(): void {
    console.log("[DownDraft MCP] Server started (stdio transport)");
  }
}
