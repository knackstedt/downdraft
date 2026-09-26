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

interface UiState {
    simReady: boolean;
    paused: boolean;
    propCount: number;
    playerHealth: number;
    playerMaxHealth: number;
    playerDead: boolean;
    cameraMode: number;
    activeFunMode: number;
    showEscMenu: boolean;
    showContentBrowser: boolean;
    activeTool: number;
    escMenuTab: string;
}

interface WorldState {
    camera: { position: [number, number, number]; target: [number, number, number] };
    count: number;
}

describe("andrews-sandbox gameplay parity", () => {
  let game: GameProcess | null = null;

  const uiState = async (): Promise<UiState> => {
    const result = (await game!.mcpClient.callTool("get_ui_state", {})) as McpToolResult;
    return parseJsonContent(result) as UiState;
  };

  const worldState = async (): Promise<WorldState> => {
    const result = (await game!.mcpClient.callTool("get_world_state", {})) as McpToolResult;
    return parseJsonContent(result) as WorldState;
  };

  const key = async (k: string, code: string, type: "keydown" | "keyup" | "press" = "press"): Promise<void> => {
    if (type === "press") {
      await game!.mcpClient.callTool("dispatch_key", { key: k, code, type: "keydown" });
      await game!.mcpClient.callTool("dispatch_key", { key: k, code, type: "keyup" });
      return;
    }
    await game!.mcpClient.callTool("dispatch_key", { key: k, code, type });
  };

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
    await sleep(2000);
  }, 180000);

  afterAll(async () => {
    await game?.kill();
  }, 30000);

  it("moves the camera while W is held (keydown/keyup state)", async () => {
    const before = await worldState();
    await key("w", "KeyW", "keydown");
    await sleep(1200);
    await key("w", "KeyW", "keyup");
    const after = await worldState();
    const dx = after.camera.position[0] - before.camera.position[0];
    const dz = after.camera.position[2] - before.camera.position[2];
    expect(Math.hypot(dx, dz)).toBeGreaterThan(0.5);
  }, 30000);

  it("opens the content browser on KeyB and closes on KeyB", async () => {
    await key("b", "KeyB");
    await sleep(400);
    expect((await uiState()).showContentBrowser).toBe(true);
    const meta = await captureAndSaveScreenshot(game!, "andrews-sandbox-browser.png", true);
    expect(meta.width).toBeGreaterThan(0);
    await key("b", "KeyB");
    await sleep(400);
    expect((await uiState()).showContentBrowser).toBe(false);
  }, 30000);

  it("opens the ESC menu on Escape and closes on Escape", async () => {
    await key("Escape", "Escape");
    await sleep(400);
    expect((await uiState()).showEscMenu).toBe(true);
    await captureAndSaveScreenshot(game!, "andrews-sandbox-escmenu.png", true);
    await key("Escape", "Escape");
    await sleep(400);
    expect((await uiState()).showEscMenu).toBe(false);
  }, 30000);

  it("switches tools via Digit keys", async () => {
    await key("3", "Digit3");
    await sleep(300);
    expect((await uiState()).activeTool).toBe(3); // ToolType.Pistol
    await key("1", "Digit1");
    await sleep(300);
    expect((await uiState()).activeTool).toBe(1); // ToolType.Physgun
  }, 30000);

  it("cycles fun mode on KeyF", async () => {
    const before = (await uiState()).activeFunMode;
    await key("f", "KeyF");
    await sleep(300);
    const after = (await uiState()).activeFunMode;
    expect(after).toBe((before + 1) % 5);
    // Cycle back so subsequent tests run under Normal physics.
    while ((await uiState()).activeFunMode !== 0) {
      await key("f", "KeyF");
      await sleep(200);
    }
  }, 30000);

  it("responds to mouse clicks in the ESC menu", async () => {
    // mousedown+mouseup reaches the native PixiUI router (real clicks arrive
    // as down/up pairs); a bare "click" hits DOM handlers on Electron. Send
    // all three — each runtime consumes its own half, no double-activation.
    const click = async (x: number, y: number) => {
      for (let _i = 0, _it = ["mousedown", "mouseup", "click"], _n = _it.length; _i < _n; _i++) { const type = _it[_i];
        await game!.mcpClient.callTool("dispatch_click", { x, y, type });
      }
    };
    await key("Escape", "Escape");
    await sleep(400);
    expect((await uiState()).showEscMenu).toBe(true);
    // Sidebar is 220px wide on both runtimes; tab centers are at
    // y = 100 + i*43 (native mirrors the DOM sidebar geometry).
    await click(40, 186); // "Mods" is index 2
    await sleep(400);
    expect((await uiState()).escMenuTab).toBe("mods");
    await click(40, 144); // "Graphics" is index 1
    await sleep(400);
    expect((await uiState()).escMenuTab).toBe("graphics");
    await key("Escape", "Escape");
    await sleep(400);
    expect((await uiState()).showEscMenu).toBe(false);
  }, 30000);

  it("spawns a prop via sandbox_command", async () => {
    const before = (await uiState()).propCount;
    const cam = (await worldState()).camera;
    const dx = cam.target[0] - cam.position[0];
    const dy = cam.target[1] - cam.position[1];
    const dz = cam.target[2] - cam.position[2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    await game!.mcpClient.callTool("sandbox_command", {
      type: "spawn",
      contentId: "builtin:cube",
      position: [
        cam.position[0] + (dx / dl) * 5,
        cam.position[1] + (dy / dl) * 5 + 2,
        cam.position[2] + (dz / dl) * 5,
      ],
      shape: "box",
    });
    await sleep(1500);
    expect((await uiState()).propCount).toBe(before + 1);
  }, 30000);

  it("reports no console errors during gameplay", () => {
    const errors = game!.getConsoleErrors();
    expect(errors).toEqual([]);
  });
});
