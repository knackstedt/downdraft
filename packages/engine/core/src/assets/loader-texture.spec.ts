// Specs for the KTX2/embedded-texture decode path: magic detection, the
// vkFormat level-index parser, compressed block geometry, device feature
// probing, and the basisu codec dispatch in decodeEmbeddedTexture.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compressedBlockInfo,
  decodeEmbeddedTexture,
  deviceCompressionFeatures,
  isKTX2Data,
  parseKTX2FromBuffer,
} from "./loader-texture";

const KTX2_FIXTURE = join(
  import.meta.dir,
  "..", "..", "..", "..", "..",
  "tests", "fixtures", "textures", "test_rgba8.ktx2",
);

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("isKTX2Data", () => {
  it("detects the KTX2 identifier", () => {
    expect(isKTX2Data(readFileSync(KTX2_FIXTURE).buffer as ArrayBuffer)).toBe(true);
  });
  it("rejects non-KTX2 bytes and short buffers", () => {
    expect(isKTX2Data(PNG_BYTES)).toBe(false);
    expect(isKTX2Data(new Uint8Array([0xab, 0x4b]))).toBe(false);
  });
});

describe("parseKTX2FromBuffer", () => {
  const fixture = readFileSync(KTX2_FIXTURE).buffer as ArrayBuffer;

  it("parses an uncompressed RGBA8 KTX2 via the level index", () => {
    const tex = parseKTX2FromBuffer(fixture);
    expect(tex).not.toBeNull();
    expect(tex!.width).toBe(4);
    expect(tex!.height).toBe(4);
    expect(tex!.format).toBe("rgba8unorm");
    expect(tex!.mipLevels).toBe(1);
    // Pixel data is sliced through the level index (64 bytes), not "everything
    // after the header".
    expect(tex!.data.byteLength).toBe(64);
    // Generator writes R=x*64, G=y*64, B=128, A=255; texel (0,0) = 0,0,128,255.
    expect(Array.from(tex!.data.subarray(0, 4))).toEqual([0, 0, 128, 255]);
  });

  it("returns null for vkFormat=0 (basisu — needs the transcode path)", () => {
    const buf = fixture.slice(0);
    new DataView(buf).setUint32(12, 0, true);
    expect(parseKTX2FromBuffer(buf)).toBeNull();
  });

  it("maps compressed vkFormats to WebGPU formats", () => {
    // vkFormat 145 = VK_FORMAT_BC7_UNORM_BLOCK.
    const buf = fixture.slice(0);
    new DataView(buf).setUint32(12, 145, true);
    const tex = parseKTX2FromBuffer(buf);
    expect(tex!.format).toBe("bc7-rgba-unorm");
  });
});

describe("compressedBlockInfo", () => {
  it("reports 4x4 16-byte blocks for BC7", () => {
    expect(compressedBlockInfo("bc7-rgba-unorm")).toEqual({ blockWidth: 4, blockHeight: 4, blockBytes: 16 });
  });
  it("reports 8-byte blocks for BC1/BC4/ETC2/EAC-R11", () => {
    expect(compressedBlockInfo("bc1-rgba-unorm").blockBytes).toBe(8);
    expect(compressedBlockInfo("bc4-r-unorm").blockBytes).toBe(8);
    expect(compressedBlockInfo("etc2-rgb8unorm").blockBytes).toBe(8);
    expect(compressedBlockInfo("eac-r11unorm").blockBytes).toBe(8);
  });
  it("parses ASTC footprints from the format name", () => {
    expect(compressedBlockInfo("astc-6x5-unorm" as GPUTextureFormat)).toEqual({ blockWidth: 6, blockHeight: 5, blockBytes: 16 });
    expect(compressedBlockInfo("astc-4x4-unorm-srgb").blockWidth).toBe(4);
  });
});

describe("deviceCompressionFeatures", () => {
  it("returns only the compression features the device exposes", () => {
    const device = { features: new Set(["texture-compression-bc", "timestamp-query"]) } as unknown as GPUDevice;
    expect(deviceCompressionFeatures(device)).toEqual(["texture-compression-bc"]);
  });
  it("returns [] for devices without a features set", () => {
    expect(deviceCompressionFeatures({} as GPUDevice)).toEqual([]);
  });
});

describe("decodeEmbeddedTexture", () => {
  it("returns null for non-KTX2 input", async () => {
    expect(await decodeEmbeddedTexture(PNG_BYTES.buffer as ArrayBuffer)).toBeNull();
  });

  it("parses concrete-vkFormat KTX2 without the codec", async () => {
    const fixture = readFileSync(KTX2_FIXTURE).buffer as ArrayBuffer;
    const tex = await decodeEmbeddedTexture(fixture, { compressionFeatures: ["texture-compression-bc"], srgb: true });
    expect(tex).not.toBeNull();
    expect(tex!.format).toBe("rgba8unorm");
    expect(tex!.width).toBe(4);
  });

  it("routes vkFormat=0 (basisu) through the texture codec with device features", async () => {
    const { GLTFCodecRegistry, getDefaultCodecRegistry, setDefaultCodecRegistry } = await import(
      "@downdraft/engine/libraries/models"
    );
    const saved = getDefaultCodecRegistry();
    const calls: { compressionFeatures?: readonly string[]; srgb?: boolean }[] = [];
    const stub = new GLTFCodecRegistry();
    stub.registerTextureCodec({
      uri: "KHR_texture_basisu",
      async decode(input) {
        calls.push({ compressionFeatures: input.compressionFeatures, srgb: input.srgb });
        return {
          data: new Uint8Array(16),
          width: 4,
          height: 4,
          format: "bc7-rgba-unorm-srgb",
          mipLevels: 1,
          isHDR: false,
        };
      },
    });
    setDefaultCodecRegistry(stub);
    try {
      const buf = readFileSync(KTX2_FIXTURE).buffer as ArrayBuffer;
      const basisuBytes = buf.slice(0);
      new DataView(basisuBytes).setUint32(12, 0, true); // vkFormat=0 → basisu
      const tex = await decodeEmbeddedTexture(basisuBytes, {
        compressionFeatures: ["texture-compression-bc"],
        srgb: true,
      });
      expect(tex).not.toBeNull();
      expect(tex!.format).toBe("bc7-rgba-unorm-srgb");
      expect(calls).toHaveLength(1);
      expect(calls[0].compressionFeatures).toEqual(["texture-compression-bc"]);
      expect(calls[0].srgb).toBe(true);
    } finally {
      setDefaultCodecRegistry(saved);
    }
  });
});
