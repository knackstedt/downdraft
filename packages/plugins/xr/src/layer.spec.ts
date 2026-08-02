import { XRLayerManager } from "./layer.ts";

describe("XRLayerManager", () => {
  it("should start with no layer", () => {
    const mgr = new XRLayerManager();
    expect(mgr.getLayer()).toBeNull();
  });

  it("should throw when init called without XRGPUBinding", () => {
    const mgr = new XRLayerManager();
    // Create a mock GPUDevice
    const mockDevice = {} as GPUDevice;
    const mockSession = {} as XRSession;
    expect(() => mgr.init(mockDevice, mockSession)).toThrow();
  });

  it("should return null viewport/projection when no frame data", () => {
    const mgr = new XRLayerManager();
    expect(mgr.getViewport("left")).toBeNull();
    expect(mgr.getViewport("right")).toBeNull();
    expect(mgr.getProjectionMatrix("left")).toBeNull();
    expect(mgr.getProjectionMatrix("right")).toBeNull();
    expect(mgr.getViewMatrix("left")).toBeNull();
    expect(mgr.getViewMatrix("right")).toBeNull();
    expect(mgr.hasView("left")).toBe(false);
    expect(mgr.hasView("right")).toBe(false);
  });

  it("should handle beginFrame with no layer gracefully", () => {
    const mgr = new XRLayerManager();
    const mockFrame = {} as XRFrame;
    const mockRefSpace = {} as XRReferenceSpace;
    expect(() => mgr.beginFrame(mockFrame, mockRefSpace)).not.toThrow();
  });
});
