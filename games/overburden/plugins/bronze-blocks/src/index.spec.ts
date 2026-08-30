import { ModuleHost, PluginHost, setStrict, World } from "@downdraft/core";
import plugin, { BronzeBlockTok } from "./index";

describe("overburden-bronze-blocks plugin", () => {
  beforeAll(() => setStrict(false));
  afterAll(() => setStrict(null));

  it("provides BronzeBlockTok with block + recipe and publishes on first tick", async () => {
    const world = new World();
    const mh = new ModuleHost(world);
    const host = new PluginHost({
      gameId: "downdraft-overburden",
      engineVersion: "0.1.0",
      moduleHost: mh,
    });
    // Inline loader: call the plugin's register directly.
    host.registerLoader({
      format: "worker-js",
      async load(manifest, ctx) {
        await plugin.register(ctx as any);
      },
    });
    host.discover(
      {
        id: "overburden-bronze-blocks",
        name: "Bronze Blocks",
        version: "1.0.0",
        engineVersion: "^0.1.0",
        game: "downdraft-overburden",
        format: "worker-js",
        tier: "native",
        thread: "sim",
        entry: "./src/index.ts",
        permissions: ["ecs", "events", "state", "tick", "log"],
      },
      "local",
    );
    await host.loadAll();

    // The typed token should be provided on the ModuleHost.
    const res = mh.injectOptional(BronzeBlockTok);
    expect(res).toBeDefined();
    expect(res?.block.name).toBe("Bronze Block");
    expect(res?.block.color).toEqual([205, 127, 50]);
    expect(res?.recipe.station).toBe("furnace");
    expect(res?.recipe.output.itemId).toBe("bronze_block");

    // Plugin should be active.
    const snap = host.snapshot();
    expect(snap.find((p) => p.id === "overburden-bronze-blocks")?.status).toBe("active");

    host.disposeAll();
  });
});
