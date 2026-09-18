import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    launchGame,
    sleep,
    type GameProcess,
} from "./harness";

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined;

describe("falling-sand screenshot", () => {
  let game: GameProcess | null = null;

  beforeAll(async () => {
    game = await launchGame({
      configPath: "games/falling-sand/electron.vite.config.ts",
      mcpPort: MCP_PORT,
      gpu: (process.env.DOWNDRAFT_GPU as "swiftshader" | undefined) ?? "swiftshader",
      deterministic: true,
      ignoreErrorPatterns: [
        /PIXI.*warning/i,
        /WebGL.*context.*lost/i,
        /perf.*extension/i,
        /dynamic import will not move/i,
      ],
    });
  }, 180000);

  afterAll(async () => {
    await game?.kill();
  }, 30000);

  it("captures a screenshot of the overlay", async () => {
    await sleep(5000);

    // Query scene state to verify the overlay is rendering
    const stateResult = await game!.mcpClient.callToolWithRetry("pixi_get_scene_state", {}, {});
    const stateContent = stateResult.content?.[0];
    expect(stateContent?.type).toBe("text");
    const state = JSON.parse(stateContent!.text);
    expect(state.nodes).toBeDefined();
    expect(state.nodes.length).toBeGreaterThan(0);
    expect(state.backend).toBeDefined();

    // Capture the overlay as PNG
    const result = await game!.mcpClient.callToolWithRetry("pixi_capture_overlay", {}, {});
    const contents = result.content as Array<{ type: string; data?: string; text?: string }>;
    // First content is JSON metadata, second is the image
    const imageContent = contents.find((c) => c.type === "image");
    expect(imageContent).toBeDefined();
    expect(imageContent!.data).toBeDefined();
    const buf = Buffer.from(imageContent!.data!, "base64");
    await Bun.write("/tmp/falling-sand-overlay.png", buf);
    console.log(`Screenshot saved to /tmp/falling-sand-overlay.png (${buf.length} bytes)`);
  }, 30000);
});
