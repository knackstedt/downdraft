import { TelemetryCollector } from "./collector.ts";
import { DebugOverlay, DEFAULT_DEBUG_OVERLAY_CONFIG } from "./debug-overlay.ts";

describe("DebugOverlay", () => {
  it("should be hidden by default", () => {
    const t = new TelemetryCollector(true);
    const overlay = new DebugOverlay(t);
    expect(overlay.isVisible()).toBe(false);
  });

  it("should toggle visibility", () => {
    const t = new TelemetryCollector(true);
    const overlay = new DebugOverlay(t);
    overlay.toggle();
    expect(overlay.isVisible()).toBe(true);
    overlay.toggle();
    expect(overlay.isVisible()).toBe(false);
  });

  it("should produce a UIRoot with panel children", () => {
    const t = new TelemetryCollector(true);
    const overlay = new DebugOverlay(t);
    const root = overlay.getRoot();
    expect(root).toBeDefined();
    expect(root.children.length).toBeGreaterThan(0);
    expect(root.children[0].type).toBe("panel");
  });

  it("should update text elements with telemetry data", () => {
    const t = new TelemetryCollector(true);
    t.recordFrame(16.67);
    t.recordFrame(16.67);
    t.recordDrawStats(10, 3000);
    t.recordGpuTime(5.2);

    const overlay = new DebugOverlay(t, { updateIntervalMs: 0 });
    overlay.setVisible(true);
    overlay.setScreenSize(1920, 1080);
    overlay.update(0.0167);

    const root = overlay.getRoot();
    const drawables = root.getDrawable();
    expect(drawables.length).toBeGreaterThan(0);

    // Should have text drawables with FPS info
    const textDrawables = drawables.filter((d) => d.kind === "text");
    expect(textDrawables.length).toBeGreaterThan(0);

    const fpsText = textDrawables.find((d) => d.text?.startsWith("FPS:"));
    expect(fpsText).toBeDefined();
    expect(fpsText!.text).not.toBe("FPS: --");
  });

  it("should not update when hidden", () => {
    const t = new TelemetryCollector(true);
    t.recordFrame(16.67);

    const overlay = new DebugOverlay(t);
    overlay.update(0.0167);

    // Overlay should be hidden
    expect(overlay.isVisible()).toBe(false);
  });

  it("should respect config options", () => {
    const t = new TelemetryCollector(true);
    const overlay = new DebugOverlay(t, {
      showFPS: false,
      showDrawCalls: false,
      showGpuTime: false,
      showMemory: false,
      showPercentiles: false,
      showFrameTime: false,
    });

    const root = overlay.getRoot();
    const panel = root.children[0];
    // Only the panel background rect, no text children
    expect(panel.children.length).toBe(0);
  });

  it("should use default config values", () => {
    expect(DEFAULT_DEBUG_OVERLAY_CONFIG.showFPS).toBe(true);
    expect(DEFAULT_DEBUG_OVERLAY_CONFIG.showDrawCalls).toBe(true);
    expect(DEFAULT_DEBUG_OVERLAY_CONFIG.showMemory).toBe(true);
    expect(DEFAULT_DEBUG_OVERLAY_CONFIG.position).toBe("top-left");
  });

  it("should position panel based on screen size", () => {
    const t = new TelemetryCollector(true);
    const overlay = new DebugOverlay(t, { position: "bottom-right" });
    overlay.setScreenSize(1920, 1080);
    overlay.setVisible(true);

    const panel = overlay.getRoot().children[0];
    expect(panel.x).toBeGreaterThan(1000);
    expect(panel.y).toBeGreaterThan(500);
  });

  it("should clean up on destroy", () => {
    const t = new TelemetryCollector(true);
    const overlay = new DebugOverlay(t);
    overlay.destroy();
    const root = overlay.getRoot();
    expect(root.children.length).toBe(0);
  });
});
