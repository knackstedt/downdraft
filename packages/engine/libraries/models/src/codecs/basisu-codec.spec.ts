// Specs for the basisu texture codec's transcode-target selection plus a real
// round-trip: encode RGBA → basisu KTX2 (ktx2-encoder) → transcode through the
// codec and verify the emitted GPU format and byte layout.
import { describe, expect, it } from "bun:test";
import { createBasisuTextureCodec, selectBasisuTranscodeTarget } from "./basisu-codec";

describe("selectBasisuTranscodeTarget", () => {
  it("picks BC7 sRGB when texture-compression-bc is available", () => {
    const t = selectBasisuTranscodeTarget(["texture-compression-bc"], true);
    expect(t.gpuFormat).toBe("bc7-rgba-unorm-srgb");
    expect(t.transcodeFormat).toBe(6); // cTFBC7_RGBA
  });

  it("picks BC7 linear for non-sRGB data", () => {
    expect(selectBasisuTranscodeTarget(["texture-compression-bc"], false).gpuFormat).toBe("bc7-rgba-unorm");
  });

  it("picks ASTC 4x4 when only texture-compression-astc is available", () => {
    expect(selectBasisuTranscodeTarget(["texture-compression-astc"], true).gpuFormat).toBe("astc-4x4-unorm-srgb");
  });

  it("picks ETC2 when only texture-compression-etc2 is available", () => {
    expect(selectBasisuTranscodeTarget(["texture-compression-etc2"], false).gpuFormat).toBe("etc2-rgba8unorm");
  });

  it("prefers BC over ASTC/ETC2 when several are present", () => {
    const t = selectBasisuTranscodeTarget(
      ["texture-compression-etc2", "texture-compression-astc", "texture-compression-bc"],
      true,
    );
    expect(t.gpuFormat).toBe("bc7-rgba-unorm-srgb");
  });

  it("falls back to rgba8unorm without compression features", () => {
    expect(selectBasisuTranscodeTarget(undefined, false).gpuFormat).toBe("rgba8unorm");
    expect(selectBasisuTranscodeTarget([], true).gpuFormat).toBe("rgba8unorm-srgb");
    expect(selectBasisuTranscodeTarget(["float32-filterable"], false).gpuFormat).toBe("rgba8unorm");
  });
});

/** Encode a small RGBA image to a real basisu (vkFormat=0) KTX2 via ktx2-encoder. */
async function encodeTestKTX2(width = 16, height = 16): Promise<Uint8Array> {
  const { Jimp } = await import("jimp");
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = x * 16;
      pixels[i + 1] = y * 16;
      pixels[i + 2] = 128;
      pixels[i + 3] = 255;
    }
  }
  const img = new Jimp({ width, height, data: Buffer.from(pixels.buffer) });
  const png = await img.getBuffer("image/png");
  const { encodeToKTX2 } = await import("ktx2-encoder");
  return encodeToKTX2(new Uint8Array(png), {
    isUASTC: false, // ETC1S — fast for test-sized images
    generateMipmap: false,
    imageDecoder: async (buf: Uint8Array) => {
      const decoded = await Jimp.read(Buffer.from(buf));
      const { data, width: w, height: h } = decoded.bitmap;
      return { width: w, height: h, data: new Uint8Array(data) };
    },
  });
}

describe("basisu codec round-trip", () => {
  it("transcodes to RGBA32 when no compression features are available", async () => {
    const ktx2 = await encodeTestKTX2();
    // Sanity: the encoder produced basisu KTX2 (magic + vkFormat=0).
    expect(ktx2[1]).toBe(0x4b); // 'K'
    expect(new DataView(ktx2.buffer, ktx2.byteOffset).getUint32(12, true)).toBe(0);

    const codec = createBasisuTextureCodec();
    const out = await codec.decode({ data: ktx2, extension: {} });
    expect(out.format).toBe("rgba8unorm");
    expect(out.width).toBe(16);
    expect(out.height).toBe(16);
    expect(out.data.byteLength).toBeGreaterThanOrEqual(16 * 16 * 4);
  }, 60000);

  it("transcodes to BC7 when texture-compression-bc is available", async () => {
    const ktx2 = await encodeTestKTX2();
    const codec = createBasisuTextureCodec();
    const out = await codec.decode({
      data: ktx2,
      extension: {},
      compressionFeatures: ["texture-compression-bc"],
      srgb: true,
    });
    expect(out.format).toBe("bc7-rgba-unorm-srgb");
    expect(out.width).toBe(16);
    expect(out.height).toBe(16);
    // BC7: 16 bytes per 4x4 block; 16x16 mip 0 = 4*4*16 = 256 bytes total.
    const mip0 = Math.ceil(out.width / 4) * Math.ceil(out.height / 4) * 16;
    expect(out.data.byteLength).toBeGreaterThanOrEqual(mip0);
    expect(out.data.byteLength).toBeLessThan(16 * 16 * 4);
  }, 60000);
});
