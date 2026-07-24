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
import { createAudioTools, createAnimationTools } from "./tools/audio-animation.ts";
import { createBuildTools } from "./tools/build.ts";
import { createResources } from "./resources/index.ts";
import { createPrompts } from "./prompts/index.ts";

export interface MCPServerOptions {
  enableTelemetry?: boolean;
  sceneName?: string;
}

export class MCPServer {
  private ctx: EngineContext;
  private undoRedo: UndoRedoManager;
  private tools: Map<string, ToolRegistration> = new Map();
  private resources: Map<string, ResourceRegistration> = new Map();
  private prompts: Map<string, PromptRegistration> = new Map();
  private started: boolean = false;

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
    this.started = true;
    console.log("[DownDraft MCP] Server started (stdio transport)");
    console.log(`[DownDraft MCP] ${this.tools.size} tools, ${this.resources.size} resources, ${this.prompts.size} prompts registered`);
  }

  stop(): void {
    this.started = false;
    console.log("[DownDraft MCP] Server stopped");
  }

  isRunning(): boolean {
    return this.started;
  }
}
