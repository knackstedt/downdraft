// ============================================================================
// MCP Setup — create EngineContext + MCPServer, listen for IPC requests from main process
// ============================================================================

import { EngineContext, MCPServer } from "@downdraft/engine/mcp";
import type { TestScene } from "./test-scene";
import { createLogger } from "@downdraft/engine/util/logger";
const log = createLogger();


export function setupMCP(scene: TestScene): void {
  // Create engine context — use a fresh EngineContext since this is a standalone test
  const ctx = new EngineContext({ sceneName: "plugin-tester", enableTelemetry: true });

  // Create MCP server
  const server = new MCPServer({ engineContext: ctx });

  // Expose game state on window for external inspection
  (window as any).__gameState = {
    getSnapshot: () => scene.getSnapshot(),
    navmesh: scene.navmesh,
    water: scene.water,
  };

  // Expose MCP server for IPC forwarding
  (window as any).__mcpServer = server;

  // Listen for MCP requests from main process (via IPC)
  // The main process forwards HTTP requests to the renderer via IPC
  const downdraft = (window as any).downdraft;
  if (downdraft && downdraft.onMcpRequest) {
    downdraft.onMcpRequest(async (request: { id: number; method: string; params?: Record<string, unknown> }) => {
      try {
        let result: unknown;
        const { method, params = {} } = request;

        if (method === "initialize") {
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: "downdraft-mcp", version: "0.1.0" },
          };
        } else if (method === "tools/list") {
          result = {
            tools: server.listTools().map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          };
        } else if (method === "tools/call") {
          result = await server.callTool(params.name as string, (params.arguments as Record<string, unknown>) ?? {});
        } else if (method === "resources/list") {
          result = {
            resources: server.listResources().map((r) => ({
              uri: r.uri,
              name: r.name,
              description: r.description,
              mimeType: r.mimeType,
            })),
          };
        } else if (method === "resources/read") {
          result = await server.readResource(params.uri as string);
        } else if (method === "prompts/list") {
          result = {
            prompts: server.listPrompts().map((p) => ({
              name: p.name,
              description: p.description,
              arguments: p.arguments,
            })),
          };
        } else if (method === "prompts/get") {
          result = await server.getPrompt(params.name as string, (params.arguments as Record<string, string>) ?? {});
        } else if (method === "shutdown") {
          result = {};
        } else {
          result = { error: `Method not found: ${method}` };
        }

        return { id: request.id, result };
      } catch (e) {
        return { id: request.id, error: { code: -32603, message: (e as Error).message } };
      }
    });
  } else {
    log.warn("MCP", 'No electron IPC bridge available — MCP HTTP transport will not work');
  }
}
