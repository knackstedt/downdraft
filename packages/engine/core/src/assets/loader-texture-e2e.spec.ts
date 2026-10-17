// Real-device e2e: native wgpu adapter → texture-compression-bc → basisu
// transcode → BC7 texture upload → bindless array copy. Skips when no native
// adapter is available (pure-TS CI legs).
import { describe, expect, it } from "bun:test";

(globalThis as Record<string, unknown>).GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};

async function tryCreateDevice() {
  const { wgpu } = await import("@downdraft/platform-native/gpu/wgpu-ffi");
  const { queryNativeFeatures, serializeRequiredFeatures, serializeRequiredLimits } = await import(
    "@downdraft/platform-native/gpu/limits"
  );
  const { computeDeviceDescriptor } = await import("@downdraft/platform-native/gpu/device-request");
  const { WgpuDevice } = await import("@downdraft/platform-native/gpu/wgpu-device");

  const inst = wgpu.wgpu_shim_create_instance() as unknown as number;
  const adapterPtr = wgpu.wgpu_shim_request_adapter(inst, 0) as unknown as number;
  if (!adapterPtr) return null;
  const features = queryNativeFeatures(adapterPtr, false);
  const has = (f: string) => (features as unknown as { has(f: string): boolean }).has(f);
  const desc = computeDeviceDescriptor({ features: { has }, limits: {} } as GPUAdapter);
  const wireFeatures = serializeRequiredFeatures(desc.requiredFeatures as unknown as string[]);
  const wireLimits = serializeRequiredLimits(desc.requiredLimits as Record<string, number>);
  const devicePtr = wgpu.wgpu_shim_request_device(
    adapterPtr,
    wireLimits as unknown as number,
    wireLimits.length / 3,
    wireFeatures as unknown as number,
    wireFeatures.length,
  ) as unknown as number;
  if (!devicePtr) return null;
  return { device: new WgpuDevice(devicePtr, inst), requiredFeatures: desc.requiredFeatures };
}

async function encodeTestKtx2(): Promise<ArrayBuffer> {
  const { Jimp } = await import("jimp");
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    pixels[i * 4] = (i % 16) * 16;
    pixels[i * 4 + 1] = Math.floor(i / 16) * 16;
    pixels[i * 4 + 2] = 128;
    pixels[i * 4 + 3] = 255;
  }
  const png = await new Jimp({ width: 16, height: 16, data: pixels }).getBuffer("image/png");
  const { encodeToKTX2 } = await import("ktx2-encoder");
  const ktx2 = await encodeToKTX2(new Uint8Array(png), {
    isUASTC: false,
    generateMipmap: true,
    imageDecoder: async (buf: Uint8Array) => {
      const d = await Jimp.read(Buffer.from(buf));
      return { width: d.bitmap.width, height: d.bitmap.height, data: new Uint8Array(d.bitmap.data) };
    },
  });
  return ktx2.buffer.slice(ktx2.byteOffset, ktx2.byteOffset + ktx2.byteLength) as ArrayBuffer;
}

describe("BC7 real-device e2e", () => {
  it("transcodes to BC7 and uploads through real wgpu + bindless registry", async () => {
    const ctx = await tryCreateDevice().catch(() => null);
    const requireGpu = process.env.DD_REQUIRE_GPU === "1";
    if (!ctx) {
      if (requireGpu) throw new Error("DD_REQUIRE_GPU=1 but no wgpu adapter was available");
      console.log("  (skip) no native wgpu adapter available");
      return;
    }
    const { device, requiredFeatures } = ctx;
    if (!(requiredFeatures as unknown as string[]).includes("texture-compression-bc")) {
      if (requireGpu) throw new Error("DD_REQUIRE_GPU=1 but adapter lacks texture-compression-bc");
      console.log("  (skip) adapter lacks texture-compression-bc");
      return;
    }

    const { decodeEmbeddedTexture, createGPUTextureFromData } = await import("./loader-texture");
    const ktx2 = await encodeTestKtx2();
    const texData = await decodeEmbeddedTexture(ktx2, {
      compressionFeatures: (requiredFeatures as unknown as string[]).filter((f) =>
        f.startsWith("texture-compression"),
      ),
      srgb: true,
    });
    expect(texData).not.toBeNull();
    expect(texData!.format).toBe("bc7-rgba-unorm-srgb");
    expect(texData!.mipLevels).toBeGreaterThan(1);

    const gpuTex = createGPUTextureFromData(device as unknown as GPUDevice, texData!);
    expect(gpuTex).toBeTruthy();

    const { BindlessTextureRegistry } = await import("../render/bindless/texture-registry");
    const registry = new BindlessTextureRegistry(device as unknown as GPUDevice);
    const reg = registry.registerFromTexture("bc7-src", gpuTex, {
      format: texData!.format,
      width: texData!.width,
      height: texData!.height,
      mipCount: texData!.mipLevels,
      sampleCount: 1,
    });
    expect(reg.handle).toBeGreaterThan(0);
  });
});
