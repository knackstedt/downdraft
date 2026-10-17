// Specs for computeDeviceDescriptor — the shared requestDevice descriptor the
// native host builds. Verifies texture-compression features are requested only
// when the adapter actually exposes them.
import { describe, expect, it } from "bun:test";
import { computeDeviceDescriptor } from "./device-request";
import type { WgpuAdapter } from "./wgpu-device";

function makeAdapter(features: string[], limits: Record<string, number> = {}): WgpuAdapter {
  return {
    features: new Set(features),
    limits,
    nativeInfo: null,
  } as unknown as WgpuAdapter;
}

describe("computeDeviceDescriptor", () => {
  it("requests texture-compression features the adapter exposes", () => {
    const d = computeDeviceDescriptor(makeAdapter(["texture-compression-bc", "texture-compression-astc"]));
    expect(d.requiredFeatures).toContain("texture-compression-bc");
    expect(d.requiredFeatures).toContain("texture-compression-astc");
    expect(d.requiredFeatures).not.toContain("texture-compression-etc2");
  });

  it("requests no compression features on adapters without them", () => {
    const d = computeDeviceDescriptor(makeAdapter([]));
    expect(d.requiredFeatures ?? []).toHaveLength(0);
  });

  it("does not request timestamp features unless the adapter exposes them", () => {
    const d = computeDeviceDescriptor(makeAdapter(["texture-compression-bc"]));
    expect(d.requiredFeatures).not.toContain("timestamp-query");
  });
});
