// ============================================================================
// PixiUI Demo — e2e smoke test via MCP automation harness
//
// Launches the pixi-ui-demo example, drives the PixiJS overlay through MCP
// tools, and asserts that:
//   - The PixiUI MCP tools are registered.
//   - The scene-graph query returns the expected HUD elements.
//   - The overlay canvas renders a non-empty PNG.
//   - A synthetic pointer event on the pause button triggers a game action.
//   - No console errors occurred during the test.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    launchGame,
    parseJsonContent,
    sleep,
    type GameProcess,
    type McpToolResult,
} from "./harness";

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined;

describe("pixi-ui-demo MCP automation smoke", () => {
  let game: GameProcess | null = null;

  beforeAll(async () => {
    game = await launchGame({
      configPath: "examples/pixi-ui-demo/electron.vite.config.ts",
      mcpPort: MCP_PORT,
      gpu: (process.env.DOWNDRAFT_GPU as "swiftshader" | undefined) ?? "swiftshader",
      deterministic: true,
      // PixiJS v8 + OffscreenCanvas in a worker can emit benign warnings
      // during init on SwiftShader; ignore those.
      ignoreErrorPatterns: [
        /PIXI.*warning/i,
        /WebGL.*context.*lost/i,
        /perf.*extension/i,
      ],
    });
  }, 180000);

  afterAll(async () => {
    await game?.kill();
  }, 30000);

  it("exposes the PixiUI automation tool set", async () => {
    const tools = await game!.mcpClient.listTools();
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("pixi_capture_overlay")).toBe(true);
    expect(names.has("pixi_get_scene_state")).toBe(true);
    expect(names.has("pixi_dispatch_pointer")).toBe(true);
    expect(names.has("pixi_set_interactive")).toBe(true);
  });

  it("scene-graph query returns the expected HUD elements", async () => {
    // Wait for the worker to init + scene to mount.
    await sleep(3000);

    const result = await game!.mcpClient.callToolWithRetry("pixi_get_scene_state", {}, {
      retries: 3,
      backoffMs: 2000,
    });
    const state = parseJsonContent(result) as {
      nodes: Array<{ name: string; type: string; visible: boolean }>;
      interactive: boolean;
      backend: string;
    };

    // The scene should have the health bar, FPS text, and pause button.
    const nodeNames = new Set(state.nodes.map((n) => n.name));
    expect(nodeNames.has("health-bar")).toBe(true);
    expect(nodeNames.has("fps-text")).toBe(true);
    expect(nodeNames.has("pause-button")).toBe(true);

    // All nodes should be visible.
    state.nodes.forEach((node) => {
      expect(node.visible).toBe(true);
    });

    // The backend should be reported (webgl2 or webgpu).
    expect(state.backend).toBeTruthy();
  });

  it("overlay canvas renders a non-empty PNG", async () => {
    const result = await game!.mcpClient.callToolWithRetry("pixi_capture_overlay", {}, {
      retries: 3,
      backoffMs: 2000,
    }) as McpToolResult;

    // The result should have text content with dimensions + an image content.
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThanOrEqual(1);

    // Find the text content (dimensions) and image content (PNG).
    const textContent = result.content.find((c) => c.type === "text");
    const imageContent = result.content.find((c) => c.type === "image");

    expect(textContent).toBeDefined();
    expect(imageContent).toBeDefined();

    if (textContent?.text) {
      const dims = JSON.parse(textContent.text);
      expect(dims.width).toBeGreaterThan(0);
      expect(dims.height).toBeGreaterThan(0);
      expect(dims.sizeBytes).toBeGreaterThan(0);
    }

    if (imageContent?.data) {
      // Base64 PNG data — should be non-empty.
      expect(imageContent.data.length).toBeGreaterThan(100);
    }
  });

  it("pause button click triggers a game action", async () => {
    // Ensure interactive mode is on (so pointer events reach PixiJS).
    await game!.mcpClient.callTool("pixi_set_interactive", { interactive: true });

    // The pause button is at (16, 112) with size 120x36.
    // Click at the center: (76, 130).
    await game!.mcpClient.callTool("pixi_dispatch_pointer", {
      type: "pointerdown",
      x: 76,
      y: 130,
      button: 0,
    });
    await game!.mcpClient.callTool("pixi_dispatch_pointer", {
      type: "pointerup",
      x: 76,
      y: 130,
      button: 0,
    });

    // Give the worker time to process the click + post the action.
    await sleep(1000);

    // Verify the scene state shows the button text changed to "Resume".
    const result = await game!.mcpClient.callTool("pixi_get_scene_state", {});
    const state = parseJsonContent(result) as {
      nodes: Array<{
        name: string;
        children?: Array<{ name: string; text?: string }>;
      }>;
    };

    const button = state.nodes.find((n) => n.name === "pause-button");
    expect(button).toBeDefined();
    const buttonText = button?.children?.find((c) => c.name === "pause-button-text");
    expect(buttonText).toBeDefined();
    expect(buttonText?.text).toBe("Resume");
  });

  it("no console errors occurred", () => {
    const errors = game!.getConsoleErrors();
    if (errors.length > 0) {
      console.error("Console errors detected:", errors);
    }
    expect(errors.length).toBe(0);
  });
});
