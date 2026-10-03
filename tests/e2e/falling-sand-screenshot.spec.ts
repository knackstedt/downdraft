import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    captureAndSaveScreenshot,
    gameAvailable,
    launchGame,
    parseJsonContent,
    sleep,
    type GameProcess,
    type McpToolResult
} from "./harness";

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined;

describe.skipIf(!gameAvailable("falling-sand"))("falling-sand screenshot", () => {
  let game: GameProcess | null = null;

  beforeAll(async () => {
    game = await launchGame({
      game: "falling-sand",
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

  it("reports UI state via get_ui_state", async () => {
    const result = (await game!.mcpClient.callTool("get_ui_state", {})) as McpToolResult;
    const state = parseJsonContent(result) as {
      paused: boolean;
      selectedMaterial: number;
      brushMode: string;
      brushRadius: number;
      rendererReady: boolean;
    };
    expect(state.rendererReady).toBe(true);
    expect(state.selectedMaterial).toBeGreaterThan(0);
    expect(state.brushMode).toBeDefined();
  }, 30000);

  it("captures a non-empty screenshot", async () => {
    await sleep(2000);
    const meta = await captureAndSaveScreenshot(game!, "falling-sand-smoke.png", true);
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  }, 30000);
});
