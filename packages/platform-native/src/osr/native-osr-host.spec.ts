// ============================================================================
// native-osr-host.spec.ts — host-level OSR bridge verification
//
// Exercises createNativeOsrHost end to end against the real cdylib: renderer
// lifecycle, panel atlas packing, content updates, input routing, frame pull.
// Skips when the .so isn't built (native artifacts aren't built in CI).
// ============================================================================

import { describe, expect, it } from "bun:test";
import { createNativeOsrHost } from "./native-osr-host";

const host = createNativeOsrHost();

describe.skipIf(!host.available)("native-osr host (bridge API over Blitz)", () => {
  const W = 400;
  const H = 200;
  const HTML = `<html><body style="margin:0;background:#123456;">
    <div data-ui style="position:absolute;left:10px;top:10px;width:100px;height:50px;background:#ff8800;">Hi</div>
  </body></html>`;

  it("createRenderer + setContent + pullFrame yields pixels", async () => {
    await host.api.createRenderer({ id: "r1", mode: "dedicated", width: W, height: H, frameRate: 30 });
    await host.api.setContent("r1", HTML);
    const px = host.api.pullFrame!("r1");
    expect(px).not.toBeNull();
    expect(px!.length).toBe(W * H * 4);
    // Corner = body background #123456.
    expect(px![0]).toBe(0x12);
    expect(px![1]).toBe(0x34);
    expect(px![2]).toBe(0x56);
    // Second pull is clean (no new pixels).
    expect(host.api.pullFrame!("r1")).toBeNull();
    await host.api.destroyRenderer("r1");
  });

  it("input events that change visuals mark the frame dirty", async () => {
    await host.api.createRenderer({ id: "r2", mode: "dedicated", width: W, height: H, frameRate: 30 });
    // :hover restyle — pointer arrival produces real damage, so the frame
    // repaints (input no longer unconditionally dirties the doc). The base
    // style must come from the stylesheet — inline styles outrank :hover.
    await host.api.setContent("r2", `<html><body style="margin:0;background:#123456;">
      <style>#box { background: #ff8800; } #box:hover { background: #00ff00; }</style>
      <div id="box" data-ui style="position:absolute;left:10px;top:10px;width:100px;height:50px;">Hi</div>
    </body></html>`);
    host.api.pullFrame!("r2"); // drain initial frame
    host.api.sendInputEvent("r2", { type: "mouseMove", x: 20, y: 20 });
    const px = host.api.pullFrame!("r2");
    expect(px).not.toBeNull(); // hovered box repaints green
    await host.api.destroyRenderer("r2");
  });

  it("input that changes nothing leaves the frame clean", async () => {
    await host.api.createRenderer({ id: "r2b", mode: "dedicated", width: W, height: H, frameRate: 30 });
    await host.api.setContent("r2b", HTML);
    host.api.pullFrame!("r2b"); // drain initial frame
    host.api.sendInputEvent("r2b", { type: "mouseMove", x: 20, y: 20 });
    host.api.sendInputEvent("r2b", { type: "mouseDown", x: 20, y: 20, button: "left" });
    host.api.sendInputEvent("r2b", { type: "mouseUp", x: 20, y: 20, button: "left" });
    host.api.sendInputEvent("r2b", { type: "mouseWheel", x: 20, y: 20, deltaY: 120 });
    host.api.sendInputEvent("r2b", { type: "keyDown", x: 0, y: 0, keyCode: "a" });
    // No :hover/:active rules, nothing scrollable, no focused input — the
    // repaint never happens and the pixel diff stays clean.
    expect(host.api.pullFrame!("r2b")).toBeNull();
    await host.api.destroyRenderer("r2b");
  });

  it("atlas mode packs panels and emits layout callbacks", async () => {
    const layouts: string[] = [];
    host.api.onPanelLayout((rid, layout) => {
      layouts.push(`${rid}:${[...layout.panels.keys()].join(",")}`);
    });
    await host.api.createRenderer({ id: "r3", mode: "atlas", width: 1024, height: 512, frameRate: 30 });
    const rectA = await host.api.addPanel({ id: "a", rendererId: "r3", html: `<div style="background:#f00;width:200px;height:100px;"></div>`, width: 200, height: 100 });
    const rectB = await host.api.addPanel({ id: "b", rendererId: "r3", html: `<div style="background:#0f0;width:200px;height:100px;"></div>`, width: 200, height: 100 });
    expect(rectA).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(rectB).toEqual({ x: 200, y: 0, w: 200, h: 100 }); // shelf-packed beside A
    expect(layouts.some((l) => l.includes("r3:a,b"))).toBe(true);

    // Atlas doc rasterizes both panels into one buffer.
    const px = host.api.pullFrame!("r3");
    expect(px).not.toBeNull();
    expect(px!.length).toBe(1024 * 512 * 4);
    const at = (x: number, y: number) => (y * 1024 + x) * 4;
    expect(px![at(50, 50)]).toBeGreaterThan(0xc0);   // panel A red
    expect(px![at(250, 50) + 1]).toBeGreaterThan(0xc0); // panel B green
    await host.api.destroyRenderer("r3");
  });

  it("updateData substitutes {{key}} placeholders in panel HTML", async () => {
    await host.api.createRenderer({ id: "r4", mode: "atlas", width: 256, height: 128, frameRate: 30 });
    await host.api.addPanel({
      id: "p", rendererId: "r4",
      html: `<div style="position:absolute;left:0;top:0;width:64px;height:32px;background:#000;color:#fff;">{{label}}</div>`,
      width: 64, height: 32,
    });
    host.api.pullFrame!("r4");
    host.api.updateData("r4", "p", { label: "SPEED" });
    expect(host.api.pullFrame!("r4")).not.toBeNull(); // re-rendered with substituted html
    await host.api.destroyRenderer("r4");
  });

  it("hitTest detects data-ui elements", async () => {
    await host.api.createRenderer({ id: "r5", mode: "dedicated", width: W, height: H, frameRate: 30 });
    await host.api.setContent("r5", HTML);
    host.api.pullFrame!("r5"); // resolve layout
    expect(host.api.hitTest!("r5", 20, 20)).toBe(true);
    expect(host.api.hitTest!("r5", 350, 150)).toBe(false);
    await host.api.destroyRenderer("r5");
  });
});
