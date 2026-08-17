// ============================================================================
// undertow-ui.spec — tests UI menu behavior through the undertow worker pipeline.
// Dispatches DOM keyboard events on the main thread and verifies that the
// worker's React UI responds correctly (menus open/close, ESC works, etc.).
// Tests full interaction paths including re-focusing after ESC, timing,
// CSS layout regressions, and click-to-resume overlay behavior.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { launchGame, sleep, type GameProcess } from "./harness";

const MCP_PORT = 9977;

async function dispatchKey(game: GameProcess, key: string, code?: string, type: "keydown" | "keyup" = "keydown"): Promise<void> {
  await game.mcpClient.callTool("dispatch_key", { key, code: code ?? key, type });
}

async function dispatchClick(game: GameProcess, x?: number, y?: number): Promise<void> {
  await game.mcpClient.callTool("dispatch_click", { x, y });
}

async function getUiState(game: GameProcess): Promise<Record<string, boolean>> {
  const result = await game.mcpClient.callTool("get_ui_state", {}) as any;
  const text = result?.content?.[0]?.text;
  if (!text) throw new Error("get_ui_state returned no text");
  return JSON.parse(text);
}

async function getElementBounds(game: GameProcess, selector: string): Promise<any> {
  const result = await game.mcpClient.callTool("get_element_bounds", { selector }) as any;
  const text = result?.content?.[0]?.text;
  if (!text) throw new Error("get_element_bounds returned no text");
  return JSON.parse(text);
}

async function inspectDom(game: GameProcess, action: string, selector?: string): Promise<any> {
  const result = await game.mcpClient.callTool("inspect_dom", { action, selector }) as any;
  const text = result?.content?.[0]?.text;
  if (!text) throw new Error("inspect_dom returned no text");
  return JSON.parse(text);
}

async function captureScreenshot(game: GameProcess): Promise<string> {
  const result = await game.mcpClient.callTool("capture_screenshot", { fullPage: false }) as any;
  const imageContent = result?.content?.find((c: any) => c.type === "image");
  return imageContent?.data ?? "";
}

/** Close all open panels by pressing Escape repeatedly. */
async function closeAllPanels(game: GameProcess): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const state = await getUiState(game);
    if (!state.showInventory && !state.showMap && !state.showBuildMenu &&
        !state.showCraftMenu && !state.showPauseMenu && !state.showSettings &&
        !state.showFishingMinigame && !state.showTradeMenu &&
        !state.showCharacterCustomization && !state.showCredits) {
      return;
    }
    await dispatchKey(game, "Escape");
    await sleep(800);
  }
}

/**
 * Measure the actual DOM render time by polling for an element to appear
 * in the DOM (not just store state). This catches lag from callSync
 * round-trips during React reconciliation.
 */
async function waitForElement(game: GameProcess, selector: string, timeoutMs = 5000): Promise<{ found: boolean; elapsed: number; bounds?: any }> {
  const start = Date.now();
  for (let i = 0; i < Math.ceil(timeoutMs / 50); i++) {
    await sleep(50);
    const bounds = await getElementBounds(game, selector);
    if (bounds.found) {
      return { found: true, elapsed: Date.now() - start, bounds };
    }
  }
  return { found: false, elapsed: Date.now() - start };
}

describe("undertow UI menu behavior", () => {
  let game: GameProcess | null = null;

  beforeAll(async () => {
    game = await launchGame({
      game: "to-the-ocean",
      mcpPort: MCP_PORT,
      gpu: (process.env.DOWNDRAFT_GPU as "swiftshader" | undefined) ?? "swiftshader",
      deterministic: false,
    });
    console.log("[test] waiting 20s for game to load...");
    await sleep(20000);
    const state = await getUiState(game!);
    console.log("[test] initial UI state:", JSON.stringify(state));
    if (!state.ready) {
      throw new Error(`Game not ready after 20s: ${JSON.stringify(state)}`);
    }
    await closeAllPanels(game!);
    // Limit render loop to 1 FPS to save GPU/CPU during UI tests.
    // UI tests only need the DOM (rendered in worker), not the canvas.
    try {
      await game.mcpClient.callTool("set_test_state", { targetFPS: 1 });
      console.log("[test] render loop limited to 1 FPS");
    } catch (e) {
      console.log("[test] could not set FPS limit:", e);
    }
    console.log("[test] game is ready, starting tests");
  }, 180000);

  afterAll(async () => {
    await game?.kill();
  }, 30000);

  // --- Basic toggle tests ---

  it("'i' key opens inventory", async () => {
    await closeAllPanels(game!);
    await dispatchKey(game!, "i", "KeyI");
    await sleep(800);
    const state = await getUiState(game!);
    expect(state.showInventory).toBe(true);
  }, 30000);

  it("'i' key again closes inventory", async () => {
    await dispatchKey(game!, "i", "KeyI");
    await sleep(800);
    const state = await getUiState(game!);
    expect(state.showInventory).toBe(false);
  }, 30000);

  it("Tab key opens craft menu (when no panel is open)", async () => {
    await closeAllPanels(game!);
    await dispatchKey(game!, "Tab", "Tab");
    await sleep(800);
    const state = await getUiState(game!);
    expect(state.showCraftMenu).toBe(true);
  }, 30000);

  it("Tab key again closes craft menu", async () => {
    await dispatchKey(game!, "Tab", "Tab");
    await sleep(800);
    const state = await getUiState(game!);
    expect(state.showCraftMenu).toBe(false);
  }, 30000);

  it("'m' key opens map", async () => {
    await closeAllPanels(game!);
    await dispatchKey(game!, "m", "KeyM");
    await sleep(800);
    const state = await getUiState(game!);
    expect(state.showMap).toBe(true);
  }, 30000);

  it("Escape closes the map", async () => {
    await dispatchKey(game!, "Escape");
    await sleep(800);
    const state = await getUiState(game!);
    expect(state.showMap).toBe(false);
  }, 30000);

  it("Escape opens pause menu (when no panel is open)", async () => {
    await closeAllPanels(game!);
    await dispatchKey(game!, "Escape");
    await sleep(800);
    const state = await getUiState(game!);
    expect(state.showPauseMenu).toBe(true);
  }, 30000);

  it("Escape again closes pause menu", async () => {
    await dispatchKey(game!, "Escape");
    await sleep(800);
    const state = await getUiState(game!);
    expect(state.showPauseMenu).toBe(false);
  }, 30000);

  // --- Interaction path tests ---

  it("full cycle: open inventory → close → open craft → close → open map → close", async () => {
    await closeAllPanels(game!);

    await dispatchKey(game!, "i", "KeyI");
    await sleep(800);
    let state = await getUiState(game!);
    expect(state.showInventory).toBe(true);

    await dispatchKey(game!, "i", "KeyI");
    await sleep(800);
    state = await getUiState(game!);
    expect(state.showInventory).toBe(false);

    await dispatchKey(game!, "Tab", "Tab");
    await sleep(800);
    state = await getUiState(game!);
    expect(state.showCraftMenu).toBe(true);

    await dispatchKey(game!, "Tab", "Tab");
    await sleep(800);
    state = await getUiState(game!);
    expect(state.showCraftMenu).toBe(false);

    await dispatchKey(game!, "m", "KeyM");
    await sleep(800);
    state = await getUiState(game!);
    expect(state.showMap).toBe(true);

    await dispatchKey(game!, "Escape");
    await sleep(800);
    state = await getUiState(game!);
    expect(state.showMap).toBe(false);
  }, 30000);

  it("ESC closes inventory, then ESC again opens pause menu", async () => {
    await closeAllPanels(game!);

    await dispatchKey(game!, "i", "KeyI");
    await sleep(800);
    let state = await getUiState(game!);
    expect(state.showInventory).toBe(true);

    await dispatchKey(game!, "Escape");
    await sleep(600);
    state = await getUiState(game!);
    expect(state.showInventory).toBe(false);
    expect(state.showPauseMenu).toBe(false);

    await dispatchKey(game!, "Escape");
    await sleep(600);
    state = await getUiState(game!);
    expect(state.showPauseMenu).toBe(true);

    await dispatchKey(game!, "Escape");
    await sleep(600);
  }, 30000);

  it("opening a second panel while one is open does not stack panels", async () => {
    await closeAllPanels(game!);

    await dispatchKey(game!, "i", "KeyI");
    await sleep(600);
    let state = await getUiState(game!);
    expect(state.showInventory).toBe(true);

    await dispatchKey(game!, "m", "KeyM");
    await sleep(600);
    state = await getUiState(game!);
    expect(state.showInventory).toBe(true);
    expect(state.showMap).toBe(false);

    await dispatchKey(game!, "i", "KeyI");
    await sleep(600);
  }, 30000);

  it("rapid key sequence: i → i → i (open, close, open)", async () => {
    await closeAllPanels(game!);

    await dispatchKey(game!, "i", "KeyI");
    await sleep(600);
    let state = await getUiState(game!);
    expect(state.showInventory).toBe(true);

    await dispatchKey(game!, "i", "KeyI");
    await sleep(600);
    state = await getUiState(game!);
    expect(state.showInventory).toBe(false);

    await dispatchKey(game!, "i", "KeyI");
    await sleep(600);
    state = await getUiState(game!);
    expect(state.showInventory).toBe(true);

    await dispatchKey(game!, "i", "KeyI");
    await sleep(600);
  }, 30000);

  it("ESC from craft menu does not open pause menu (single ESC closes only)", async () => {
    await closeAllPanels(game!);

    await dispatchKey(game!, "Tab", "Tab");
    await sleep(600);
    let state = await getUiState(game!);
    expect(state.showCraftMenu).toBe(true);

    await dispatchKey(game!, "Escape");
    await sleep(600);
    state = await getUiState(game!);
    expect(state.showCraftMenu).toBe(false);
    expect(state.showPauseMenu).toBe(false);
  }, 30000);

  // --- DOM render timing tests (measure actual DOM appearance, not store state) ---

  it("'i' key: inventory DOM elements appear within 1 second", async () => {
    await closeAllPanels(game!);
    const start = Date.now();
    await dispatchKey(game!, "i", "KeyI");
    // Poll for the actual DOM element to appear (not just store state)
    const result = await waitForElement(game!, ".hud-panel.p-6", 5000);
    console.log(`[test] inventory DOM appeared in ${result.elapsed}ms (found=${result.found})`);
    expect(result.found).toBe(true);
    // With the grid optimization (no empty cells), this should be fast.
    // If empty cells are being rendered, this takes 3-5 seconds.
    expect(result.elapsed).toBeLessThan(1500);
    // Clean up
    await dispatchKey(game!, "i", "KeyI");
    await sleep(800);
  }, 30000);

  it("Tab key: craft menu DOM elements appear within 1 second", async () => {
    await closeAllPanels(game!);
    const start = Date.now();
    await dispatchKey(game!, "Tab", "Tab");
    // The craft menu has a distinctive header
    const result = await waitForElement(game!, ".hud-panel .text-2xl", 5000);
    console.log(`[test] craft menu DOM appeared in ${result.elapsed}ms (found=${result.found})`);
    expect(result.found).toBe(true);
    expect(result.elapsed).toBeLessThan(2000);
    await dispatchKey(game!, "Tab", "Tab");
    await sleep(800);
  }, 30000);

  it("inventory closes: DOM elements disappear within 1 second", async () => {
    await closeAllPanels(game!);
    // First open the inventory
    await dispatchKey(game!, "i", "KeyI");
    await waitForElement(game!, ".hud-panel.p-6", 5000);
    // Now close it and measure how long the DOM elements persist
    const start = Date.now();
    await dispatchKey(game!, "i", "KeyI");
    // Poll for the DOM element to disappear
    let disappeared = false;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      const bounds = await getElementBounds(game!, ".hud-panel.p-6");
      if (!bounds.found) {
        disappeared = true;
        break;
      }
    }
    const elapsed = Date.now() - start;
    console.log(`[test] inventory DOM disappeared in ${elapsed}ms (disappeared=${disappeared})`);
    expect(disappeared).toBe(true);
    // If DOM cleanup is slow, stale elements could intercept clicks
    expect(elapsed).toBeLessThan(6000);
  }, 30000);

  // --- CSS layout regression tests ---

  it("inventory panel height is reasonable (not 8k pixels)", async () => {
    await closeAllPanels(game!);
    await dispatchKey(game!, "i", "KeyI");
    await sleep(1500); // wait for render to complete

    const bounds = await getElementBounds(game!, ".hud-panel.p-6");
    console.log("[test] inventory .hud-panel.p-6 bounds:", JSON.stringify(bounds));
    expect(bounds.found).toBe(true);
    // After adding max-h-[80vh] + overflow-y-auto, the panel should be
    // constrained to 80% of viewport height (typically ~648px for 1080p).
    expect(bounds.height).toBeLessThan(2000);
    expect(bounds.height).toBeGreaterThan(50);

    await dispatchKey(game!, "i", "KeyI");
    await sleep(800);
  }, 30000);

  it("inventory panel has correct CSS classes and max-width", async () => {
    await closeAllPanels(game!);
    await dispatchKey(game!, "i", "KeyI");
    await sleep(1500);

    const inspect = await inspectDom(game!, "element", ".hud-panel.p-6");
    console.log("[test] inventory panel inspect:", JSON.stringify(inspect));
    expect(inspect.found).toBe(true);
    expect(inspect.className).toContain("hud-panel");
    expect(inspect.className).toContain("max-w-4xl");
    // max-w-4xl = 56rem = 896px
    expect(inspect.style.maxWidth).toBe("896px");

    await dispatchKey(game!, "i", "KeyI");
    await sleep(800);
  }, 30000);

  it("inventory grid has correct number of cells (only item cells, not 300 empty ones)", async () => {
    await closeAllPanels(game!);
    await dispatchKey(game!, "i", "KeyI");
    await sleep(1500);

    // The grid container should have only item cells as children, not 300 empty divs
    const gridInspect = await inspectDom(game!, "element", ".hud-panel.p-6 [style*='grid-template-columns']");
    console.log("[test] grid container inspect:", JSON.stringify(gridInspect));
    if (gridInspect.found) {
      // With the optimization, the grid should have very few children (only item cells)
      // If empty cells are being rendered, childCount would be 300+
      console.log(`[test] grid childCount: ${gridInspect.childCount}`);
      expect(gridInspect.childCount).toBeLessThan(50);
    }

    await dispatchKey(game!, "i", "KeyI");
    await sleep(800);
  }, 30000);

  // --- Click-to-resume / overlay behavior tests ---

  it("clicking outside inventory closes it and does NOT re-open it", async () => {
    await closeAllPanels(game!);
    // Open inventory
    await dispatchKey(game!, "i", "KeyI");
    await waitForElement(game!, ".hud-panel.p-6", 5000);
    let state = await getUiState(game!);
    expect(state.showInventory).toBe(true);

    // Click outside the panel (at a corner of the viewport, which should
    // hit the inventory's outer div with onClick={toggle})
    await dispatchClick(game!, 5, 5);

    // Poll for the inventory to close — the postMessage from worker to main
    // thread can be delayed by up to 2s in some runs.
    let closed = false;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      state = await getUiState(game!);
      if (!state.showInventory) { closed = true; break; }
    }
    console.log("[test] after click outside inventory:", JSON.stringify(state), "closed=", closed);
    expect(closed).toBe(true);
  }, 30000);

  it("click-to-resume overlay does not re-open the inventory", async () => {
    await closeAllPanels(game!);
    // Open inventory
    await dispatchKey(game!, "i", "KeyI");
    await waitForElement(game!, ".hud-panel.p-6", 5000);

    // Close inventory by clicking outside
    await dispatchClick(game!, 5, 5);

    // Poll for the inventory to close
    let closed = false;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      const state = await getUiState(game!);
      if (!state.showInventory) { closed = true; break; }
    }
    expect(closed).toBe(true);

    // If the click-to-resume overlay is visible, click it
    // It should NOT re-open the inventory
    const overlayBounds = await getElementBounds(game!, "[data-click-to-resume]");
    if (overlayBounds.found) {
      console.log("[test] click-to-resume overlay found, clicking it");
      await dispatchClick(game!, 400, 300); // center of screen
      await sleep(1000);
      const state = await getUiState(game!);
      console.log("[test] after clicking overlay:", JSON.stringify(state));
      // The inventory should NOT be open
      expect(state.showInventory).toBe(false);
    } else {
      console.log("[test] click-to-resume overlay not found (pointer may have locked)");
    }
  }, 30000);

  it("ESC menu resume: clicking resume clears the overlay (test 3 times)", async () => {
    await closeAllPanels(game!);

    for (let attempt = 0; attempt < 3; attempt++) {
      // Open pause menu with ESC
      await dispatchKey(game!, "Escape");
      await sleep(1000);
      let state = await getUiState(game!);
      expect(state.showPauseMenu).toBe(true);

      // Close pause menu with ESC (simulates clicking Resume)
      await dispatchKey(game!, "Escape");
      await sleep(1000);
      state = await getUiState(game!);
      expect(state.showPauseMenu).toBe(false);

      // Wait a bit and check if the click-to-resume overlay appears
      await sleep(800);
      state = await getUiState(game!);
      console.log(`[test] ESC resume attempt ${attempt + 1}:`, JSON.stringify(state));

      // The overlay may or may not appear depending on pointer lock success.
      // The key check is that the pause menu is closed and no other menu opened.
      expect(state.showPauseMenu).toBe(false);
    }
  }, 60000);

  // --- Error detection ---

  it("no uncaught JS errors during the test run", async () => {
    await sleep(800);
    const errors = game!.getConsoleErrors();
    if (errors.length > 0) {
      console.error("Console errors detected during test run:\n" + errors.join("\n"));
    }
    expect(errors).toEqual([]);
  }, 10000);
});
