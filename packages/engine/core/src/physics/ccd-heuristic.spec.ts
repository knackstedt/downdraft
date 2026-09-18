import { CCDHeuristic } from "./ccd-heuristic";

describe("CCDHeuristic", () => {
  it("should not enable CCD for slow bodies", () => {
    const ccd = new CCDHeuristic({ ccdTunnelingRatio: 0.5 });
    expect(ccd.shouldEnableCCD([1, 0, 0], 1, 1 / 60)).toBe(false);
  });

  it("should enable CCD for fast bodies (tunneling risk)", () => {
    const ccd = new CCDHeuristic({ ccdTunnelingRatio: 0.5 });
    // speed=100, dt=1/60, size=1 → risk = 100/60 ≈ 1.67 > 0.5
    expect(ccd.shouldEnableCCD([100, 0, 0], 1, 1 / 60)).toBe(true);
  });

  it("should not enable CCD for zero-size colliders", () => {
    const ccd = new CCDHeuristic({ ccdTunnelingRatio: 0.5 });
    expect(ccd.shouldEnableCCD([100, 0, 0], 0, 1 / 60)).toBe(false);
  });

  it("should compute tunneling risk correctly", () => {
    const ccd = new CCDHeuristic({ ccdTunnelingRatio: 0.5 });
    // speed=30, dt=1/60, size=1 → risk = 30/60 = 0.5 → NOT > 0.5
    expect(ccd.shouldEnableCCD([30, 0, 0], 1, 1 / 60)).toBe(false);
    // speed=31, dt=1/60, size=1 → risk ≈ 0.517 > 0.5
    expect(ccd.shouldEnableCCD([31, 0, 0], 1, 1 / 60)).toBe(true);
  });

  it("should handle 3D velocity magnitude", () => {
    const ccd = new CCDHeuristic({ ccdTunnelingRatio: 0.5 });
    // speed = sqrt(50^2 + 50^2 + 50^2) ≈ 86.6, size=1, dt=1/60 → risk ≈ 1.44
    expect(ccd.shouldEnableCCD([50, 50, 50], 1, 1 / 60)).toBe(true);
  });

  it("should update CCD on bodies via backend", () => {
    const ccd = new CCDHeuristic({ ccdTunnelingRatio: 0.5 });
    let ccdEnabled = false;
    const backend = {
      getLinearVelocity: () => [100, 0, 0],
      setCCDEnabled: (_b: any, enabled: boolean) => { ccdEnabled = enabled; },
    } as any;
    ccd.updateCCD(backend, [{ id: 1, realmId: 0, entity: { index: 0, generation: 0 } }], 1 / 60, () => 1);
    expect(ccdEnabled).toBe(true);
  });
});
