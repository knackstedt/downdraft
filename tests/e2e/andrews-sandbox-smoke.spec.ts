import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    captureAndSaveScreenshot,
    appAvailable,
    launchApp,
    parseJsonContent,
    sleep,
    type AppProcess,
    type McpToolResult
} from "./harness";

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined;

describe.skipIf(!appAvailable("andrews-sandbox"))("andrews-sandbox MCP automation smoke", () => {
  let app: AppProcess | null = null;

  beforeAll(async () => {
    app = await launchApp({
      app: "andrews-sandbox",
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
    await app?.kill();
  }, 30000);

  it("exposes the automation tool set", async () => {
    const tools = await app!.mcpClient.listTools();
    const names = new Set(tools.map((t) => t.name));
    ["capture_screenshot", "get_ui_state", "dispatch_key", "wait_for_condition"].forEach((name) => {
      expect(names.has(name)).toBe(true);
    });
  });

  it("reports app state via get_ui_state", async () => {
    const result = (await app!.mcpClient.callTool("get_ui_state", {})) as McpToolResult;
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
    const meta = await captureAndSaveScreenshot(app!, "andrews-sandbox-smoke.png", true);
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  }, 30000);

  it("reports no console errors during boot", () => {
    const errors = app!.getConsoleErrors();
    expect(errors).toEqual([]);
  });
});
