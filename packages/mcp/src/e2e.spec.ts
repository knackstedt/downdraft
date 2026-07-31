import { MCPServer } from "../src/server.ts";
import type { MCPToolResult } from "../src/types.ts";

function parseJSON(result: MCPToolResult): Record<string, unknown> {
  const text = result.content[0]?.type === "text" ? result.content[0].text : "{}";
  return JSON.parse(text);
}

describe("MCP End-to-End: AI Agent Scene Building", () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer({ sceneName: "e2e-test" });
  });

  it("should list all expected tools", () => {
    const tools = server.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("create_scene");
    expect(names).toContain("spawn_entity");
    expect(names).toContain("generate_procedural_mesh");
    expect(names).toContain("assign_mesh");
    expect(names).toContain("create_material");
    expect(names).toContain("assign_material");
    expect(names).toContain("add_light");
    expect(names).toContain("set_camera");
    expect(names).toContain("create_checkpoint");
    expect(names).toContain("configure_shadows");
    expect(names).toContain("convert_asset");
    expect(names).toContain("validate_build");
    expect(names).toContain("add_audio_source");
    expect(names).toContain("play_animation");
    expect(names).toContain("hot_reload_shader");
    expect(names).toContain("set_camera_mode");
    expect(names).toContain("set_lod");

    expect(names.length).toBeGreaterThanOrEqual(30);
  });

  it("should list all expected resources", () => {
    const resources = server.listResources();
    const uris = resources.map((r) => r.uri);

    expect(uris).toContain("downdraft://scene-tree");
    expect(uris).toContain("downdraft://entity-state");
    expect(uris).toContain("downdraft://performance");
    expect(uris).toContain("downdraft://gpu-info");
    expect(uris).toContain("downdraft://asset-list");
    expect(uris).toContain("downdraft://checkpoint-list");
  });

  it("should list all expected prompts", () => {
    const prompts = server.listPrompts();
    const names = prompts.map((p) => p.name);

    expect(names).toContain("create-scene");
    expect(names).toContain("add-entity");
    expect(names).toContain("debug-frame");
  });

  it("should build a complete scene via tool calls", async () => {
    // 1. Create scene
    let result = await server.callTool("create_scene", { name: "e2e-scene" });
    let data = parseJSON(result);
    expect(data.scene).toBe("e2e-scene");

    // 2. Generate a cube mesh
    result = await server.callTool("generate_procedural_mesh", { type: "cube", name: "test-cube" });
    data = parseJSON(result);
    expect(data.name).toBe("test-cube");

    // 3. Spawn an entity with a Transform component
    result = await server.callTool("spawn_entity", {
      components: {
        Transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 },
      },
    });
    data = parseJSON(result);
    expect(data.entity).toBeDefined();
    const entityKey = data.entity as string;

    // 4. Assign mesh to entity
    result = await server.callTool("assign_mesh", { entity: entityKey, mesh: "test-cube" });
    data = parseJSON(result);
    expect(data.mesh).toBe("test-cube");

    // 5. Create a PBR material
    result = await server.callTool("create_material", {
      name: "test-mat",
      type: "pbr",
      uniforms: {
        baseColor: { name: "baseColor", type: "vec4", binding: 0 },
      },
    });
    data = parseJSON(result);
    expect(data.name).toBe("test-mat");

    // 6. Assign material to entity
    result = await server.callTool("assign_material", { entity: entityKey, material: "test-mat" });
    data = parseJSON(result);
    expect(data.material).toBe("test-mat");

    // 7. Add a directional light
    result = await server.callTool("add_light", {
      type: "directional",
      direction: [0.5, 0.8, 0.3],
      intensity: 3.0,
      castShadows: true,
    });
    data = parseJSON(result);
    expect(data.lightIndex).toBe(0);

    // 8. Set camera position
    result = await server.callTool("set_camera", {
      position: [5, 5, 10],
      target: [0, 0, 0],
    });
    data = parseJSON(result);
    expect(data.target).toEqual([0, 0, 0]);
    expect(data.near).toBeGreaterThan(0);

    // 9. Create a checkpoint
    result = await server.callTool("create_checkpoint", { name: "e2e-checkpoint" });
    data = parseJSON(result);
    expect(data.name).toBe("e2e-checkpoint");
  });

  it("should support undo/redo for scene operations", async () => {
    // Spawn an entity
    let result = await server.callTool("spawn_entity", {
      components: {
        Transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: 1 },
      },
    });
    let data = parseJSON(result);
    const entityKey = data.entity as string;
    expect(entityKey).toBeDefined();

    // Undo the spawn
    result = await server.callTool("undo", {});
    data = parseJSON(result);
    expect(data.undone).toBe(true);

    // Verify entity is gone
    result = await server.callTool("get_entity_state", { entity: entityKey });
    expect(result.isError).toBe(true);

    // Redo the spawn
    result = await server.callTool("redo", {});
    data = parseJSON(result);
    expect(data.redone).toBe(true);
  });

  it("should support material undo (unregister)", async () => {
    // Create a material
    let result = await server.callTool("create_material", {
      name: "undo-test-mat",
      type: "pbr",
    });
    let data = parseJSON(result);
    expect(data.name).toBe("undo-test-mat");

    // Verify it exists
    result = await server.callTool("list_materials", {});
    data = parseJSON(result);
    const names = (data.materials as Array<{ name: string }>).map((m) => m.name);
    expect(names).toContain("undo-test-mat");

    // Undo creation
    result = await server.callTool("undo", {});
    data = parseJSON(result);
    expect(data.undone).toBe(true);

    // Verify it's gone
    result = await server.callTool("list_materials", {});
    data = parseJSON(result);
    const namesAfter = (data.materials as Array<{ name: string }>).map((m) => m.name);
    expect(namesAfter).not.toContain("undo-test-mat");

    // Redo creation
    result = await server.callTool("redo", {});
    data = parseJSON(result);
    expect(data.redone).toBe(true);

    // Verify it's back
    result = await server.callTool("list_materials", {});
    data = parseJSON(result);
    const namesAfterRedo = (data.materials as Array<{ name: string }>).map((m) => m.name);
    expect(namesAfterRedo).toContain("undo-test-mat");
  });

  it("should configure shadows on a directional light", async () => {
    const result = await server.callTool("configure_shadows", {
      lightIndex: 0,
      shadowMapSize: 4096,
      shadowBias: 0.0005,
      castShadows: true,
    });
    const data = parseJSON(result);
    expect(data.shadowMapSize).toBe(4096);
    expect(data.shadowBias).toBe(0.0005);
    expect(data.castShadows).toBe(true);
  });

  it("should validate build and report stats", async () => {
    const result = await server.callTool("validate_build", { target: "linux" });
    const data = parseJSON(result);
    expect(data.target).toBe("linux");
    expect(data.stats).toBeDefined();
    expect(data.stats.entities).toBeGreaterThan(0);
  });

  it("should read scene-tree resource", async () => {
    const result = await server.readResource("downdraft://scene-tree");
    expect(result.contents).toHaveLength(1);
    const text = result.contents[0].text;
    const data = JSON.parse(text);
    expect(data.scene).toBeDefined();
    expect(data.entities).toBeDefined();
    expect(Array.isArray(data.entities)).toBe(true);
  });

  it("should read performance resource", async () => {
    const result = await server.readResource("downdraft://performance");
    expect(result.contents).toHaveLength(1);
    const data = JSON.parse(result.contents[0].text);
    expect(data.frameTime).toBeDefined();
  });

  it("should get create-scene prompt", async () => {
    const result = await server.getPrompt("create-scene", {
      sceneName: "test-prompt-scene",
      description: "a test scene",
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content.type).toBe("text");
    const text = result.messages[0].content.text as string;
    expect(text).toContain("test-prompt-scene");
  });

  it("should set camera follow mode", async () => {
    // Spawn an entity to follow
    let result = await server.callTool("spawn_entity", {
      components: {
        Transform: { position: [10, 5, 10], rotation: [0, 0, 0, 1], scale: 1 },
      },
    });
    const data = parseJSON(result);
    const entityKey = data.entity as string;

    // Set camera to follow mode
    result = await server.callTool("set_camera_mode", {
      mode: "follow",
      followEntity: entityKey,
    });
    const modeData = parseJSON(result);
    expect(modeData.mode).toBe("follow");
    expect(modeData.followEntity).toBe(entityKey);

    // Verify via camera state
    result = await server.callTool("get_camera_state", {});
    const camData = parseJSON(result);
    expect(camData.followEntity).toBe(entityKey);
  });

  it("should set LOD levels on an entity with a mesh", async () => {
    // Spawn entity with mesh
    let result = await server.callTool("spawn_entity", {
      components: {
        Transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 },
      },
    });
    const spawnData = parseJSON(result);
    const entityKey = spawnData.entity as string;

    await server.callTool("assign_mesh", { entity: entityKey, mesh: "test-cube" });

    // Set LOD levels
    result = await server.callTool("set_lod", {
      entity: entityKey,
      levels: [
        { distance: 0, mesh: "test-cube" },
        { distance: 50, mesh: "test-cube" },
      ],
    });
    const lodData = parseJSON(result);
    expect(lodData.lodLevels).toBe(2);
  });

  it("should add audio source to entity", async () => {
    // Spawn entity
    let result = await server.callTool("spawn_entity", {
      components: {
        Transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 },
      },
    });
    const spawnData = parseJSON(result);
    const entityKey = spawnData.entity as string;

    // Add audio source
    result = await server.callTool("add_audio_source", {
      entity: entityKey,
      asset: "sounds/test.wav",
      spatial: true,
      volume: 0.8,
      loop: true,
    });
    const audioData = parseJSON(result);
    expect(audioData.spatial).toBe(true);
    expect(audioData.volume).toBe(0.8);
    expect(audioData.loop).toBe(true);
  });

  it("create_scene should use SceneManager lifecycle", async () => {
    // Spawn an entity in the current scene to verify it gets cleared
    await server.callTool("spawn_entity", {
      components: {
        Transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: 1 },
      },
    });

    // Create a new scene — should unload the old one and activate the new one
    let result = await server.callTool("create_scene", { name: "lifecycle-test" });
    let data = parseJSON(result);
    expect(data.scene).toBe("lifecycle-test");
    expect(data.entityCount).toBe(0);

    // Verify the scene manager has the new scene as current
    const ctx = (server as any).ctx;
    expect(ctx.scene.name).toBe("lifecycle-test");
    expect(ctx.world.sceneManager.getCurrentScene()).toBe(ctx.scene);
    expect(ctx.world.sceneManager.has("lifecycle-test")).toBe(true);
    expect(ctx.scene.isActive()).toBe(true);
  });

  it("create_scene should support undo back to previous scene", async () => {
    // Start from lifecycle-test (set by previous test)
    const ctx = (server as any).ctx;
    const beforeName = ctx.scene.name;

    // Create another new scene
    let result = await server.callTool("create_scene", { name: "undo-scene-test" });
    let data = parseJSON(result);
    expect(data.scene).toBe("undo-scene-test");
    expect(ctx.scene.name).toBe("undo-scene-test");

    // Undo should restore previous scene name
    result = await server.callTool("undo", {});
    data = parseJSON(result);
    expect(data.undone).toBe(true);
    expect(ctx.scene.name).toBe(beforeName);

    // Redo should go back to the new scene
    result = await server.callTool("redo", {});
    data = parseJSON(result);
    expect(data.redone).toBe(true);
    expect(ctx.scene.name).toBe("undo-scene-test");
  });
});
