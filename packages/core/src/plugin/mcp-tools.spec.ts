import { ModuleHost, PluginHost, World, createPluginMcpTools, setStrict } from "@downdraft/core";

describe("createPluginMcpTools", () => {
  beforeAll(() => setStrict(false));
  afterAll(() => setStrict(null));

  it("plugin_list returns all plugins with status", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    host.registerLoader({
      format: "quickjs",
      async load() {},
    });
    host.discover(
      {
        id: "test-plugin",
        name: "Test",
        version: "1.0.0",
        engineVersion: "^0.1.0",
        game: "test-game",
        format: "quickjs",
        tier: "script",
        thread: "renderer",
        entry: "./index.js",
        permissions: ["events"],
      },
      "local",
    );
    await host.loadAll();

    const tools = createPluginMcpTools(host);
    const listTool = tools.find((t) => t.def.name === "plugin_list")!;
    const result = await listTool.handler({}) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(1);
    expect(data.plugins[0].id).toBe("test-plugin");
    expect(data.plugins[0].status).toBe("active");

    host.disposeAll();
  });

  it("plugin_get_info returns details for a single plugin", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    host.registerLoader({ format: "quickjs", async load() {} });
    host.discover(
      {
        id: "detail-plugin",
        name: "Detail",
        version: "2.0.0",
        engineVersion: "^0.1.0",
        game: "test-game",
        format: "quickjs",
        tier: "script",
        thread: "renderer",
        entry: "./index.js",
        permissions: ["events", "state"],
      },
      "local",
    );
    await host.loadAll();

    const tools = createPluginMcpTools(host);
    const infoTool = tools.find((t) => t.def.name === "plugin_get_info")!;
    const result = await infoTool.handler({ id: "detail-plugin" }) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe("detail-plugin");
    expect(data.version).toBe("2.0.0");
    expect(data.permissions).toContain("events");

    host.disposeAll();
  });

  it("plugin_get_info returns error for unknown plugin", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    const tools = createPluginMcpTools(host);
    const infoTool = tools.find((t) => t.def.name === "plugin_get_info")!;
    const result = await infoTool.handler({ id: "nonexistent" }) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("not found");
  });

  it("plugin_reload reloads a plugin", async () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    let count = 0;
    host.registerLoader({
      format: "quickjs",
      async load() { count++; },
    });
    host.discover(
      {
        id: "reload-test",
        name: "Reload",
        version: "1.0.0",
        engineVersion: "^0.1.0",
        game: "test-game",
        format: "quickjs",
        tier: "script",
        thread: "renderer",
        entry: "./index.js",
        permissions: [],
      },
      "local",
    );
    await host.loadAll();
    expect(count).toBe(1);

    const tools = createPluginMcpTools(host);
    const reloadTool = tools.find((t) => t.def.name === "plugin_reload")!;
    const result = await reloadTool.handler({ id: "reload-test" }) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(count).toBe(2);

    host.disposeAll();
  });

  it("registers 5 tools", () => {
    const host = new PluginHost({ gameId: "test-game", engineVersion: "0.1.0" });
    const tools = createPluginMcpTools(host);
    expect(tools.length).toBe(5);
    expect(tools.map((t) => t.def.name)).toEqual([
      "plugin_list",
      "plugin_get_info",
      "plugin_reload",
      "plugin_unload",
      "plugin_get_state",
    ]);
  });
});
