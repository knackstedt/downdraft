// Render smoke — boots the real wgpu stack headlessly:
// adapter → device → shader → pipeline → render pass → draw → readback.
// This is the CI GPU-coverage leg (runs under lavapipe/SwiftShader via
// DOWNDRAFT_GPU=swiftshader) — it verifies the whole render path end to
// end instead of only checking that objects were created.
//
// No adapter (native lib missing, no Vulkan/GL driver, CPU-only CI leg) →
// skips; DD_REQUIRE_GPU=1 turns the skip into a hard failure for jobs that
// exist specifically to run it.
import { describe, expect, it } from "bun:test";

async function tryBootGpu() {
  const { installGPU } = await import("./install");
  installGPU();
  const gpu = (globalThis as Record<string, any>).navigator.gpu as GPU;
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  return { adapter, device };
}

describe("render smoke (native wgpu)", () => {
  it("renders a triangle to an offscreen texture and reads back the pixel", async () => {
    const ctx = await tryBootGpu().catch(() => null);
    if (!ctx) {
      if (process.env.DD_REQUIRE_GPU === "1") {
        throw new Error("DD_REQUIRE_GPU=1 but no wgpu adapter was available");
      }
      console.log("  (skip) no wgpu adapter — native lib or GPU driver unavailable");
      return;
    }
    const { device } = ctx;

    const W = 64;
    const H = 64;
    const target = device.createTexture({
      size: { width: W, height: H },
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    const shader = device.createShaderModule({
      code: `
        struct VSOut { @builtin(position) pos: vec4f, @location(0) color: vec4f, };
        @vertex fn vs_main(@location(0) pos: vec4f, @location(1) col: vec4f) -> VSOut {
          var out: VSOut;
          out.pos = pos;
          out.color = col;
          return out;
        }
        @fragment fn fs_main(in: VSOut) -> @location(0) vec4f { return in.color; }
      `,
    });

    // Fullscreen triangle — vertex positions in clip space, constant red.
    const verts = new Float32Array([
      -1, -3, 0, 1, 1, 0, 0, 1,
      3, 1, 0, 1, 1, 0, 0, 1,
      -1, 1, 0, 1, 1, 0, 0, 1,
    ]);
    const vbuf = device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vbuf, 0, verts);

    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shader,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x4" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
          ],
        }],
      },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        clearValue: { r: 0, g: 0, b: 1, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vbuf);
    pass.draw(3);
    pass.end();

    // bytesPerRow must respect COPY_BYTES_PER_ROW_ALIGNMENT (256).
    const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
    const readback = device.createBuffer({
      size: bytesPerRow * H,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow },
      { width: W, height: H },
    );
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(readback.getMappedRange());
    const cx = Math.floor(W / 2);
    const cy = Math.floor(H / 2);
    const i = cy * bytesPerRow + cx * 4;
    readback.unmap();

    expect(px[i]).toBeGreaterThan(200); // R
    expect(px[i + 1]).toBeLessThan(50); // G
    expect(px[i + 2]).toBeLessThan(50); // B
    expect(px[i + 3]).toBe(255); // A
  });
});
