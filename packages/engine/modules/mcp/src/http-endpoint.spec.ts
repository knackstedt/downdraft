import type { ModuleContext } from "@downdraft/engine";
import { EngineContext } from "@downdraft/engine/mcp";
import { GameClient, listGameInstances, mcpPortDir } from "@downdraft/engine/mcp/client";
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createMcpModule } from "./index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createMcpModule http transport", () => {
  it("serves the editor toolset over HTTP and advertises <pid>.editor", async () => {
    // Standalone EngineContext supplies the live-world pieces fromGame needs.
    const base = new EngineContext({ sceneName: "mcp-module-http-test" });
    const disposers: Array<() => void> = [];
    const mod = createMcpModule({
      ecsWorld: base.ecsWorld,
      scene: base.scene,
      gameWorld: base.world,
      camera: base.camera,
      transport: "http",
    });
    const ctx = {
      provide: () => {},
      onDispose: (fn: () => void) => disposers.push(fn),
    } as unknown as ModuleContext;
    mod.register(ctx);

    const editorFile = join(mcpPortDir(), `${process.pid}.editor`);
    try {
      // The transport + pid file come up asynchronously after register().
      const deadline = Date.now() + 10_000;
      while (!existsSync(editorFile) && Date.now() < deadline) await sleep(50);
      expect(existsSync(editorFile)).toBe(true);

      const inst = listGameInstances({ pid: process.pid })[0];
      expect(inst?.editorPort).toBeGreaterThan(0);
      expect(inst?.editorToken).toBeTruthy();

      const client = await GameClient.connect({ pid: process.pid, endpoint: "editor" });
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("create_scene");

      const res = await client.call("get_scene_info");
      expect(res.isError).toBeFalsy();
      const text = (res.content ?? [])
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      expect(JSON.parse(text).name).toBe("mcp-module-http-test");
    } finally {
      disposers.forEach((d) => d());
    }
    expect(existsSync(editorFile)).toBe(false);
  });
});
