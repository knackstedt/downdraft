import type { MCPToolResult } from "@downdraft/engine/mcp";
import { EngineContext, MCPServer } from "@downdraft/engine/modules/mcp";
import { beforeEach, describe, expect, it, vi } from "bun:test";

// ============================================================================
// Helper: Parse text content from MCPToolResult
// ============================================================================

function parseJSON(result: MCPToolResult): Record<string, unknown> {
  const text = result.content[0]?.type === "text" ? result.content[0].text : "{}";
  return JSON.parse(text);
}

function getText(result: MCPToolResult): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

// ============================================================================
// MCPServer Construction & Identity Tests
// ============================================================================

describe("MCPServer Construction", () => {
  it("should construct with default options", () => {
    const server = new MCPServer();
    expect(server).toBeDefined();
  });

  it("should construct with sceneName", () => {
    const server = new MCPServer({ sceneName: "test-scene" });
    expect(server.getEngineContext()).toBeDefined();
  });

  it("should construct with custom EngineContext", () => {
    const ctx = new EngineContext({ sceneName: "custom" });
    const server = new MCPServer({ engineContext: ctx });
    expect(server.getEngineContext()).toBe(ctx);
  });

  it("should not be running before start()", () => {
    const server = new MCPServer();
    expect(server.isRunning()).toBe(false);
  });

  it("should return UndoRedoManager", () => {
    const server = new MCPServer();
    expect(server.getUndoRedoManager()).toBeDefined();
  });
});

// ============================================================================
// Tools Listing Tests
// ============================================================================

describe("MCPServer Tools", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer({ sceneName: "test" });
  });

  it("should list tools as array of MCPToolDef", () => {
    const tools = server.listTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it("should have each tool with name, description, and inputSchema", () => {
    const tools = server.listTools();
    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe("string");
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("should include scene tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("create_scene");
  });

  it("should include entity tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("spawn_entity");
  });

  it("should include mesh tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("generate_procedural_mesh");
    expect(names).toContain("assign_mesh");
  });

  it("should include material tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("create_material");
    expect(names).toContain("assign_material");
  });

  it("should include lighting tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("add_light");
  });

  it("should include camera tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("set_camera");
    expect(names).toContain("set_camera_mode");
  });

  it("should include checkpoint tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("create_checkpoint");
  });

  it("should include debug tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("configure_shadows");
  });

  it("should include inspect tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("inspect_object");
  });

  it("should include asset tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("convert_asset");
  });

  it("should include audio tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("add_audio_source");
  });

  it("should include animation tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("play_animation");
  });

  it("should include build tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("validate_build");
  });

  it("should include script tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("hot_reload_shader");
  });

  it("should include physics tools", () => {
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("set_lod");
  });

  it("should have at least 30 tools", () => {
    expect(server.listTools().length).toBeGreaterThanOrEqual(30);
  });
});

// ============================================================================
// Resources Listing Tests
// ============================================================================

describe("MCPServer Resources", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer({ sceneName: "test" });
  });

  it("should list resources as array", () => {
    const resources = server.listResources();
    expect(Array.isArray(resources)).toBe(true);
    expect(resources.length).toBeGreaterThan(0);
  });

  it("should have each resource with uri, name, description", () => {
    const resources = server.listResources();
    for (const res of resources) {
      expect(res.uri).toBeDefined();
      expect(res.name).toBeDefined();
      expect(res.description).toBeDefined();
    }
  });

  it("should include scene-tree resource", () => {
    const uris = server.listResources().map((r) => r.uri);
    expect(uris).toContain("downdraft://scene-tree");
  });

  it("should include entity-state resource", () => {
    const uris = server.listResources().map((r) => r.uri);
    expect(uris).toContain("downdraft://entity-state");
  });

  it("should include performance resource", () => {
    const uris = server.listResources().map((r) => r.uri);
    expect(uris).toContain("downdraft://performance");
  });

  it("should include gpu-info resource", () => {
    const uris = server.listResources().map((r) => r.uri);
    expect(uris).toContain("downdraft://gpu-info");
  });

  it("should include asset-list resource", () => {
    const uris = server.listResources().map((r) => r.uri);
    expect(uris).toContain("downdraft://asset-list");
  });

  it("should include checkpoint-list resource", () => {
    const uris = server.listResources().map((r) => r.uri);
    expect(uris).toContain("downdraft://checkpoint-list");
  });
});

// ============================================================================
// Prompts Listing Tests
// ============================================================================

describe("MCPServer Prompts", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer({ sceneName: "test" });
  });

  it("should list prompts as array", () => {
    const prompts = server.listPrompts();
    expect(Array.isArray(prompts)).toBe(true);
    expect(prompts.length).toBeGreaterThan(0);
  });

  it("should have each prompt with name and description", () => {
    const prompts = server.listPrompts();
    for (const p of prompts) {
      expect(p.name).toBeDefined();
      expect(p.description).toBeDefined();
    }
  });

  it("should include create-scene prompt", () => {
    const names = server.listPrompts().map((p) => p.name);
    expect(names).toContain("create-scene");
  });

  it("should include add-entity prompt", () => {
    const names = server.listPrompts().map((p) => p.name);
    expect(names).toContain("add-entity");
  });

  it("should include debug-frame prompt", () => {
    const names = server.listPrompts().map((p) => p.name);
    expect(names).toContain("debug-frame");
  });
});

// ============================================================================
// Tool Calling Tests
// ============================================================================

describe("MCPServer callTool", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer({ sceneName: "test" });
  });

  it("should return error for unknown tool", async () => {
    const result = await server.callTool("nonexistent_tool", {});
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Unknown tool");
  });

  it("should create a scene", async () => {
    const result = await server.callTool("create_scene", { name: "my-scene" });
    const data = parseJSON(result);
    expect(data.scene).toBe("my-scene");
  });

  it("should generate a cube mesh", async () => {
    const result = await server.callTool("generate_procedural_mesh", { type: "cube", name: "test-cube" });
    const data = parseJSON(result);
    expect(data.name).toBe("test-cube");
  });

  it("should generate a sphere mesh", async () => {
    const result = await server.callTool("generate_procedural_mesh", { type: "sphere", name: "test-sphere" });
    const data = parseJSON(result);
    expect(data.name).toBe("test-sphere");
  });

  it("should generate a plane mesh", async () => {
    const result = await server.callTool("generate_procedural_mesh", { type: "plane", name: "test-plane" });
    const data = parseJSON(result);
    expect(data.name).toBe("test-plane");
  });

  it("should spawn an entity", async () => {
    const result = await server.callTool("spawn_entity", {
      components: {
        Transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 },
      },
    });
    const data = parseJSON(result);
    expect(data.entity).toBeDefined();
  });

  it("should create a material", async () => {
    const result = await server.callTool("create_material", {
      name: "test-mat",
      color: [1, 0, 0, 1],
    });
    const data = parseJSON(result);
    expect(data.name).toBe("test-mat");
  });

  it("should add a directional light", async () => {
    const result = await server.callTool("add_light", {
      type: "directional",
      color: [1, 1, 1],
      intensity: 1.0,
      direction: [-1, -1, -1],
    });
    expect(result.isError).toBeFalsy();
  });

  it("should add a point light", async () => {
    const result = await server.callTool("add_light", {
      type: "point",
      color: [1, 1, 1],
      intensity: 2.0,
      position: [5, 5, 5],
      range: 20,
    });
    expect(result.isError).toBeFalsy();
  });

  it("should set camera", async () => {
    const result = await server.callTool("set_camera", {
      position: [10, 10, 10],
      target: [0, 0, 0],
    });
    expect(result.isError).toBeFalsy();
  });

  it("should create a checkpoint", async () => {
    const result = await server.callTool("create_checkpoint", {
      name: "test-checkpoint",
    });
    expect(result.isError).toBeFalsy();
  });

  it("should handle tool execution errors gracefully", async () => {
    const result = await server.callTool("generate_procedural_mesh", {
      type: "invalid_type",
      name: "bad-mesh",
    });
    expect(result.isError).toBe(true);
  });
});

// ============================================================================
// Resource Reading Tests
// ============================================================================

describe("MCPServer readResource", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer({ sceneName: "test" });
  });

  it("should read scene-tree resource", async () => {
    const result = await server.readResource("downdraft://scene-tree");
    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.contents[0].uri).toBe("downdraft://scene-tree");
  });

  it("should read performance resource", async () => {
    const result = await server.readResource("downdraft://performance");
    expect(result.contents.length).toBeGreaterThan(0);
  });

  it("should read gpu-info resource", async () => {
    const result = await server.readResource("downdraft://gpu-info");
    expect(result.contents.length).toBeGreaterThan(0);
  });

  it("should read asset-list resource", async () => {
    const result = await server.readResource("downdraft://asset-list");
    expect(result.contents.length).toBeGreaterThan(0);
  });

  it("should read checkpoint-list resource", async () => {
    const result = await server.readResource("downdraft://checkpoint-list");
    expect(result.contents.length).toBeGreaterThan(0);
  });

  it("should handle unknown resource gracefully", async () => {
    const result = await server.readResource("downdraft://unknown");
    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.contents[0].text).toContain("Unknown resource");
  });
});

// ============================================================================
// Prompt Getting Tests
// ============================================================================

describe("MCPServer getPrompt", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer({ sceneName: "test" });
  });

  it("should get create-scene prompt", async () => {
    const result = await server.getPrompt("create-scene", {});
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("should get add-entity prompt", async () => {
    const result = await server.getPrompt("add-entity", {});
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("should get debug-frame prompt", async () => {
    const result = await server.getPrompt("debug-frame", {});
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("should handle unknown prompt gracefully", async () => {
    const result = await server.getPrompt("nonexistent", {});
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0].content.text).toContain("Unknown prompt");
  });
});

// ============================================================================
// UndoRedoManager Tests
// ============================================================================

describe("UndoRedoManager", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer({ sceneName: "test" });
  });

  it("should start with empty undo/redo stacks", () => {
    const mgr = server.getUndoRedoManager();
    const history = mgr.getHistory();
    expect(history.undo.length).toBe(0);
    expect(history.redo.length).toBe(0);
    expect(mgr.canUndo()).toBe(false);
    expect(mgr.canRedo()).toBe(false);
  });

  it("should execute an action and add to undo stack", () => {
    const mgr = server.getUndoRedoManager();
    mgr.execute({
      description: "test action",
      undo: vi.fn(),
      redo: vi.fn(),
    });
    expect(mgr.canUndo()).toBe(true);
    expect(mgr.canRedo()).toBe(false);
    const history = mgr.getHistory();
    expect(history.undo).toContain("test action");
  });

  it("should undo an action", () => {
    const mgr = server.getUndoRedoManager();
    const undoFn = vi.fn();
    mgr.execute({
      description: "test action",
      undo: undoFn,
      redo: vi.fn(),
    });
    const result = mgr.undo();
    expect(result).toBe(true);
    expect(undoFn).toHaveBeenCalledTimes(1);
    expect(mgr.canUndo()).toBe(false);
    expect(mgr.canRedo()).toBe(true);
  });

  it("should redo an action", () => {
    const mgr = server.getUndoRedoManager();
    const redoFn = vi.fn();
    mgr.execute({
      description: "test action",
      undo: vi.fn(),
      redo: redoFn,
    });
    mgr.undo();
    const result = mgr.redo();
    expect(result).toBe(true);
    expect(redoFn).toHaveBeenCalledTimes(1);
    expect(mgr.canRedo()).toBe(false);
    expect(mgr.canUndo()).toBe(true);
  });

  it("should return false for undo with empty stack", () => {
    const mgr = server.getUndoRedoManager();
    expect(mgr.undo()).toBe(false);
  });

  it("should return false for redo with empty stack", () => {
    const mgr = server.getUndoRedoManager();
    expect(mgr.redo()).toBe(false);
  });

  it("should clear redo stack on new execute", () => {
    const mgr = server.getUndoRedoManager();
    mgr.execute({ description: "action1", undo: vi.fn(), redo: vi.fn() });
    mgr.undo();
    expect(mgr.canRedo()).toBe(true);
    mgr.execute({ description: "action2", undo: vi.fn(), redo: vi.fn() });
    expect(mgr.canRedo()).toBe(false);
  });

  it("should clear both stacks", () => {
    const mgr = server.getUndoRedoManager();
    mgr.execute({ description: "a1", undo: vi.fn(), redo: vi.fn() });
    mgr.execute({ description: "a2", undo: vi.fn(), redo: vi.fn() });
    mgr.undo();
    mgr.clear();
    expect(mgr.canUndo()).toBe(false);
    expect(mgr.canRedo()).toBe(false);
  });

  it("should limit undo stack to maxStack size", () => {
    const mgr = server.getUndoRedoManager();
    for (let i = 0; i < 150; i++) {
      mgr.execute({ description: `action-${i}`, undo: vi.fn(), redo: vi.fn() });
    }
    const history = mgr.getHistory();
    expect(history.undo.length).toBeLessThanOrEqual(100);
  });

  it("should handle undo errors gracefully", () => {
    const mgr = server.getUndoRedoManager();
    mgr.execute({
      description: "failing action",
      undo: () => { throw new Error("undo failed"); },
      redo: vi.fn(),
    });
    const result = mgr.undo();
    expect(result).toBe(false);
    // Action should remain on undo stack
    expect(mgr.canUndo()).toBe(true);
  });

  it("should handle redo errors gracefully", () => {
    const mgr = server.getUndoRedoManager();
    mgr.execute({
      description: "failing action",
      undo: vi.fn(),
      redo: () => { throw new Error("redo failed"); },
    });
    mgr.undo();
    const result = mgr.redo();
    expect(result).toBe(false);
    // Action should remain on redo stack
    expect(mgr.canRedo()).toBe(true);
  });
});

// ============================================================================
// EngineContext Tests
// ============================================================================

describe("EngineContext", () => {
  it("should construct with default options", () => {
    const ctx = new EngineContext();
    expect(ctx).toBeDefined();
    expect(ctx.world).toBeDefined();
    expect(ctx.scene).toBeDefined();
    expect(ctx.camera).toBeDefined();
    expect(ctx.hierarchy).toBeDefined();
    expect(ctx.assetManager).toBeDefined();
    expect(ctx.materialLibrary).toBeDefined();
    expect(ctx.checkpointManager).toBeDefined();
    expect(ctx.telemetryCollector).toBeDefined();
    expect(ctx.telemetryReporter).toBeDefined();
    expect(ctx.debugDraw).toBeDefined();
    expect(ctx.scriptingSystem).toBeDefined();
    expect(ctx.saveSystem).toBeDefined();
  });

  it("should construct with sceneName", () => {
    const ctx = new EngineContext({ sceneName: "my-scene" });
    expect(ctx).toBeDefined();
  });

  it("should start with empty lights array", () => {
    const ctx = new EngineContext();
    expect(ctx.lights.length).toBe(0);
  });

  it("should start with empty meshes map", () => {
    const ctx = new EngineContext();
    expect(ctx.meshes.size).toBe(0);
  });

  it("should start with empty physics realms", () => {
    const ctx = new EngineContext();
    expect(ctx.physicsRealms.size).toBe(0);
  });

  it("should start with debugVisualizeMode 'none'", () => {
    const ctx = new EngineContext();
    expect(ctx.debugVisualizeMode).toBe("none");
  });

  it("should start with null audioEngine", () => {
    const ctx = new EngineContext();
    expect(ctx.audioEngine).toBeNull();
  });

  it("should start with empty animationPlayers", () => {
    const ctx = new EngineContext();
    expect(ctx.animationPlayers.size).toBe(0);
  });

  it("should have materialHotReloader", () => {
    const ctx = new EngineContext();
    expect(ctx.materialHotReloader).toBeDefined();
  });
});

// ============================================================================
// Start/Stop Lifecycle Tests
// ============================================================================

describe("MCPServer Lifecycle", () => {
  it("should start and set running flag", () => {
    const server = new MCPServer();
    server.start();
    expect(server.isRunning()).toBe(true);
    server.stop();
  });

  it("should stop and clear running flag", () => {
    const server = new MCPServer();
    server.start();
    server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it("should not double-start", () => {
    const server = new MCPServer();
    server.start();
    server.start();
    expect(server.isRunning()).toBe(true);
    server.stop();
  });
});
