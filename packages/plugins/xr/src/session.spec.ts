import { DEFAULT_XR_CONFIG } from "./types";
import { XRSessionManager, isXRAvailable, isXRGPUBindingAvailable } from "./session";

describe("XRSessionManager", () => {
  it("should start in idle state", () => {
    const mgr = new XRSessionManager();
    expect(mgr.getState()).toBe("idle");
    expect(mgr.isActive()).toBe(false);
    expect(mgr.getSession()).toBeNull();
    expect(mgr.getReferenceSpace()).toBeNull();
  });

  it("should throw when requesting session without navigator.xr", async () => {
    const mgr = new XRSessionManager();
    // navigator.xr is not available in test environment
    try {
      await mgr.requestSession();
      expect(false).toBe(true); // should not reach
    } catch (e) {
      expect((e as Error).message).toContain("WebXR");
    }
  });

  it("should support event listener registration", () => {
    const mgr = new XRSessionManager();
    let called = false;
    mgr.onSessionEnd(() => { called = true; });
    // Just verify it doesn't throw
    expect(called).toBe(false);
  });
});

describe("isXRAvailable", () => {
  it("should return boolean", () => {
    const result = isXRAvailable();
    expect(typeof result).toBe("boolean");
  });
});

describe("isXRGPUBindingAvailable", () => {
  it("should return boolean", () => {
    const result = isXRGPUBindingAvailable();
    expect(typeof result).toBe("boolean");
  });
});

describe("DEFAULT_XR_CONFIG", () => {
  it("should include local-floor as required feature", () => {
    expect(DEFAULT_XR_CONFIG.requiredFeatures).toContain("local-floor");
  });

  it("should include optional features array", () => {
    expect(Array.isArray(DEFAULT_XR_CONFIG.optionalFeatures)).toBe(true);
    expect(DEFAULT_XR_CONFIG.optionalFeatures.length).toBeGreaterThan(0);
  });
});
