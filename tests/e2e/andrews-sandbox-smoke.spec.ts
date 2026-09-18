import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    captureAndSaveScreenshot,
    launchGame,
    parseJsonContent,
    sleep,
    type GameProcess,
    type McpToolResult,
} from "./harness";

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined;

describe("andrews-sandbox MCP automation smoke", () => {
  let game: GameProcess | null = null;

  beforeAll(async () => {
    game = await launchGame({
      configPath: "games/andrews-sandbox/electron.vite.config.ts",
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

  it("exposes the automation tool set", async () => {
    const tools = await game!.mcpClient.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const name of ["capture_screenshot", "get_ui_state", "dispatch_key", "wait_for_condition"]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("reports game state via get_ui_state", async () => {
    const result = (await game!.mcpClient.callTool("get_ui_state", {})) as McpToolResult;
    const state = parseJsonContent(result) as {
      simReady: boolean;
      playerHealth: number;
      playerMaxHealth: number;
      playerDead: boolean;
      cameraMode: string;
      propCount: number;
    };
    expect(state.playerMaxHealth).toBeGreaterThan(0);
    expect(state.playerDead).toBe(false);
    expect(state.cameraMode).toBeDefined();
    expect(state.propCount).toBeGreaterThanOrEqual(0);
  }, 30000);

  it("captures a non-empty screenshot", async () => {
    await sleep(2000);
    const meta = await captureAndSaveScreenshot(game!, "andrews-sandbox-smoke.png", true);
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  }, 30000);

  it("reports no console errors during boot", () => {
    const errors = game!.getConsoleErrors();
    expect(errors).toEqual([]);
  });
});
