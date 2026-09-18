import { MCPServer } from "../server";
import type { MCPToolResult } from "../types";

function resultText(result: MCPToolResult): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

describe("MCP security: path traversal rejection", () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer({ sceneName: "security-test" });
  });

  describe("script tools", () => {
    it("rejects create_script with '..' in name", async () => {
      const result = await server.callTool("create_script", {
        name: "../evil",
        code: "export default 1;",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("..");
    });

    it("rejects attach_script with traversal path", async () => {
      const result = await server.callTool("attach_script", {
        name: "evil",
        path: "../../etc/passwd",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("escapes base directory");
    });

    it("rejects attach_script with absolute path outside base", async () => {
      const result = await server.callTool("attach_script", {
        name: "evil",
        path: "/etc/passwd",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("escapes base directory");
    });

    it("rejects hot_reload_script with traversal path", async () => {
      const result = await server.callTool("hot_reload_script", {
        name: "evil",
        path: "../../../secret.sh",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("escapes base directory");
    });
  });

  describe("asset tools", () => {
    it("rejects import_texture with traversal path", async () => {
      const result = await server.callTool("import_texture", {
        path: "../../etc/passwd",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("escapes base directory");
    });

    it("rejects import_texture with absolute path outside base", async () => {
      const result = await server.callTool("import_texture", {
        path: "/etc/shadow",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("escapes base directory");
    });

    it("rejects convert_asset with traversal path", async () => {
      const result = await server.callTool("convert_asset", {
        path: "../../evil/model.glb",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("escapes base directory");
    });
  });

  describe("scene tools", () => {
    it("rejects load_scene with traversal path", async () => {
      const result = await server.callTool("load_scene", {
        path: "../../etc/passwd",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("escapes base directory");
    });

    it("rejects load_scene with absolute path outside base", async () => {
      const result = await server.callTool("load_scene", {
        path: "/etc/passwd",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("escapes base directory");
    });

    it("rejects save_scene with traversal path", async () => {
      const result = await server.callTool("save_scene", {
        path: "../../../tmp/evil.json",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("escapes base directory");
    });
  });

  describe("build tools", () => {
    it("rejects export_scene with traversal path", async () => {
      const result = await server.callTool("export_scene", {
        path: "../../etc/evil.json",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("escapes base directory");
    });

    it("rejects export_scene with absolute path outside base", async () => {
      const result = await server.callTool("export_scene", {
        path: "/tmp/evil.json",
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("escapes base directory");
    });
  });
});

describe("MCP security: prototype pollution rejection", () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer({ sceneName: "security-pp-test" });
  });

  it("strips __proto__ from spawn_entity component data", async () => {
    const result = await server.callTool("spawn_entity", {
      components: {
        Transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: 1,
          __proto__: { polluted: true },
        },
      },
    });
    // Should succeed (not error) — the __proto__ key is stripped, not a failure
    expect(result.isError).toBeFalsy();
    // Verify global prototype was not polluted
    expect({} as Record<string, unknown>).not.toHaveProperty("polluted");
  });

  it("strips constructor/prototype from spawn_entity component data", async () => {
    const result = await server.callTool("spawn_entity", {
      components: {
        Transform: {
          position: [1, 2, 3],
          rotation: [0, 0, 0, 1],
          scale: 1,
          constructor: { polluted: true },
          prototype: { polluted: true },
        },
      },
    });
    expect(result.isError).toBeFalsy();
    expect({} as Record<string, unknown>).not.toHaveProperty("polluted");
  });

  it("strips __proto__ from modify_entity changes", async () => {
    // First spawn an entity with a Transform
    const spawnResult = await server.callTool("spawn_entity", {
      components: {
        Transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 },
      },
    });
    const spawnText = resultText(spawnResult);
    const spawnData = JSON.parse(spawnText);
    const entityKey = spawnData.entity as string;

    // Now modify with a __proto__ payload
    const result = await server.callTool("modify_entity", {
      entity: entityKey,
      component: "Transform",
      changes: {
        scale: 2,
        __proto__: { polluted: true },
      },
    });
    expect(result.isError).toBeFalsy();
    expect({} as Record<string, unknown>).not.toHaveProperty("polluted");
  });
});
