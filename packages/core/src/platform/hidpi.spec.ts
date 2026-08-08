import { HiDPIManager } from "./hidpi";

describe("HiDPIManager", () => {
  it("should detect scale factor via window.devicePixelRatio when available", () => {
    const originalDpr = (globalThis as any).window?.devicePixelRatio;
    const w = (globalThis as any).window;
    if (w) {
      w.devicePixelRatio = 2;
      const mgr = new HiDPIManager();
      expect(mgr.detectScaleFactor()).toBe(2);
      if (originalDpr !== undefined) w.devicePixelRatio = originalDpr;
    }
  });

  it("should fall back to platform heuristic without window", () => {
    const mgr = new HiDPIManager();
    const scale = mgr.detectScaleFactor();
    expect(scale).toBeGreaterThan(0);
  });

  it("should init and allow manual scale override", () => {
    const mgr = new HiDPIManager();
    mgr.setScaleFactor(3);
    expect(mgr.getScaleFactor()).toBe(3);
  });

  it("should fire onScaleChange callbacks", () => {
    const mgr = new HiDPIManager();
    let captured = 0;
    mgr.onScaleChange((s) => { captured = s; });
    mgr.setScaleFactor(2);
    expect(captured).toBe(2);
  });

  it("should not fire callback when scale is unchanged", () => {
    const mgr = new HiDPIManager();
    mgr.setScaleFactor(2);
    let captured = 0;
    mgr.onScaleChange((s) => { captured = s; });
    mgr.setScaleFactor(2);
    expect(captured).toBe(0);
  });
});
