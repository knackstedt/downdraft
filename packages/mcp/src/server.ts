import { EngineContext } from "./engine-context.ts";
import { UndoRedoManager } from "./undo-redo.ts";
import type {
  ToolRegistration,
  ResourceRegistration,
  PromptRegistration,
  MCPToolResult,
  MCPResourceResult,
  MCPPromptResult,
  MCPToolDef,
  MCPResourceDef,
  MCPPromptDef,
} from "./types.ts";

import { createSceneTools } from "./tools/scene.ts";
import { createEntityTools } from "./tools/entity.ts";
import { createComponentTools } from "./tools/component.ts";
import { createMaterialTools } from "./tools/material.ts";
import { createMeshTools } from "./tools/mesh.ts";
import { createLightingTools } from "./tools/lighting.ts";
import { createCameraTools } from "./tools/camera.ts";
import { createPhysicsTools } from "./tools/physics.ts";
import { createDebugTools } from "./tools/debug.ts";
import { createInspectTools } from "./tools/inspect.ts";
import { createCheckpointTools } from "./tools/checkpoint.ts";
import { createScriptTools } from "./tools/script.ts";
import { createAssetTools } from "./tools/asset.ts";
import { createAudioTools } from "./tools/audio.ts";
import { createAnimationTools } from "./tools/animation.ts";
import { createBuildTools } from "./tools/build.ts";
import { createResources } from "./resources/index.ts";
import { createPrompts } from "./prompts/index.ts";

export interface MCPServerOptions {
  enableTelemetry?: boolean;
  sceneName?: string;
}

interface JSONRPCRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "downdraft-mcp";
const SERVER_VERSION = "0.1.0";

export class MCPServer {
  private ctx: EngineContext;
  private undoRedo: UndoRedoManager;
  private tools: Map<string, ToolRegistration> = new Map();
  private resources: Map<string, ResourceRegistration> = new Map();
  private prompts: Map<string, PromptRegistration> = new Map();
  private started: boolean = false;
  private initialized: boolean = false;
  private inputBuffer: string = "";

  constructor(opts: MCPServerOptions = {}) {
    this.ctx = new EngineContext(opts);
    this.undoRedo = new UndoRedoManager(this.ctx);
    this.registerAllTools();
    this.registerAllResources();
    this.registerAllPrompts();
  }

  private registerAllTools(): void {
    const allTools: ToolRegistration[] = [
      ...createSceneTools(this.ctx, this.undoRedo),
      ...createEntityTools(this.ctx, this.undoRedo),
      ...createComponentTools(this.ctx, this.undoRedo),
      ...createMaterialTools(this.ctx, this.undoRedo),
      ...createMeshTools(this.ctx, this.undoRedo),
      ...createLightingTools(this.ctx, this.undoRedo),
      ...createCameraTools(this.ctx, this.undoRedo),
      ...createPhysicsTools(this.ctx, this.undoRedo),
      ...createDebugTools(this.ctx, this.undoRedo),
      ...createInspectTools(this.ctx),
      ...createCheckpointTools(this.ctx, this.undoRedo),
      ...createScriptTools(this.ctx),
      ...createAssetTools(this.ctx),
      ...createAudioTools(this.ctx),
      ...createAnimationTools(this.ctx),
      ...createBuildTools(this.ctx),
    ];

    for (const tool of allTools) {
      this.tools.set(tool.def.name, tool);
    }
  }

  private registerAllResources(): void {
    const allResources = createResources(this.ctx);
    for (const res of allResources) {
      this.resources.set(res.def.uri, res);
    }
  }

  private registerAllPrompts(): void {
    const allPrompts = createPrompts();
    for (const prompt of allPrompts) {
      this.prompts.set(prompt.def.name, prompt);
    }
  }

  getEngineContext(): EngineContext {
    return this.ctx;
  }

  getUndoRedoManager(): UndoRedoManager {
    return this.undoRedo;
  }

  listTools(): MCPToolDef[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  listResources(): MCPResourceDef[] {
    return [...this.resources.values()].map((r) => r.def);
  }

  listPrompts(): MCPPromptDef[] {
    return [...this.prompts.values()].map((p) => p.def);
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<MCPToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      return await tool.handler(params);
    } catch (e) {
      return {
        content: [{ type: "text", text: `Tool "${name}" failed: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }

  async readResource(uri: string): Promise<MCPResourceResult> {
    const res = this.resources.get(uri);
    if (!res) {
      return { contents: [{ uri, text: `Unknown resource: ${uri}` }] };
    }
    try {
      return await res.handler(uri);
    } catch (e) {
      return {
        contents: [{
          uri,
          text: `Resource "${uri}" failed: ${(e as Error).message}`,
        }],
      };
    }
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<MCPPromptResult> {
    const prompt = this.prompts.get(name);
    if (!prompt) {
      return { messages: [{ role: "user", content: { type: "text", text: `Unknown prompt: ${name}` } }] };
    }
    try {
      return await prompt.handler(args);
    } catch (e) {
      return {
        messages: [{
          role: "user",
          content: { type: "text", text: `Prompt "${name}" failed: ${(e as Error).message}` },
        }],
      };
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const stdin = process.stdin;
    stdin.setEncoding("utf-8");
    stdin.resume();

    stdin.on("data", (chunk: string) => {
      this.inputBuffer += chunk;
      this.processBuffer();
    });

    stdin.on("end", () => {
      this.started = false;
    });

    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        result: {
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      }) + "\n",
    );
  }

  stop(): void {
    this.started = false;
    this.initialized = false;
    this.inputBuffer = "";
    process.stdin.pause();
  }

  isRunning(): boolean {
    return this.started;
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.inputBuffer.indexOf("\n")) >= 0) {
      const line = this.inputBuffer.slice(0, newlineIdx).trim();
      this.inputBuffer = this.inputBuffer.slice(newlineIdx + 1);
      if (line) {
        this.handleLine(line).catch((e) => {
          this.sendError(0, -32603, `Internal error: ${(e as Error).message}`);
        });
      }
    }
  }

  private async handleLine(line: string): Promise<void> {
    let msg: JSONRPCRequest;
    try {
      msg = JSON.parse(line);
    } catch {
      this.sendError(0, -32700, "Parse error");
      return;
    }

    const id = msg.id ?? 0;

    if (msg.method === "initialize") {
      this.initialized = true;
      this.sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }

    if (!this.initialized) {
      this.sendError(id, -32000, "Server not initialized");
      return;
    }

    switch (msg.method) {
      case "initialized":
        return;

      case "tools/list":
        this.sendResult(id, {
          tools: this.listTools().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        return;

      case "tools/call": {
        const params = msg.params ?? {};
        const name = params.name as string;
        const args = (params.arguments as Record<string, unknown>) ?? {};
        const result = await this.callTool(name, args);
        this.sendResult(id, result);
        return;
      }

      case "resources/list":
        this.sendResult(id, {
          resources: this.listResources().map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          })),
        });
        return;

      case "resources/read": {
        const params = msg.params ?? {};
        const uri = params.uri as string;
        const result = await this.readResource(uri);
        this.sendResult(id, result);
        return;
      }

      case "prompts/list":
        this.sendResult(id, {
          prompts: this.listPrompts().map((p) => ({
            name: p.name,
            description: p.description,
            arguments: p.arguments,
          })),
        });
        return;

      case "prompts/get": {
        const params = msg.params ?? {};
        const name = params.name as string;
        const args = (params.arguments as Record<string, string>) ?? {};
        const result = await this.getPrompt(name, args);
        this.sendResult(id, result);
        return;
      }

      case "shutdown":
        this.initialized = false;
        this.sendResult(id, {});
        return;

      default:
        this.sendError(id, -32601, `Method not found: ${msg.method}`);
    }
  }

  private sendResult(id: number | string, result: unknown): void {
    const response: JSONRPCResponse = { jsonrpc: "2.0", id, result };
    process.stdout.write(JSON.stringify(response) + "\n");
  }

  private sendError(id: number | string, code: number, message: string): void {
    const response: JSONRPCResponse = { jsonrpc: "2.0", id, error: { code, message } };
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}
