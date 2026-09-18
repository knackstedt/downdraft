import { mat4 } from "wgpu-matrix";
import { TrackedRenderPass } from "../tracked-render-pass";
import type { SkyDomeUniforms } from "./sky-dome";
import { SkyDomePass } from "./sky-dome";

const FACE_DIRS: Array<{ target: [number, number, number]; up: [number, number, number] }> = [
  { target: [1, 0, 0], up: [0, -1, 0] },
  { target: [-1, 0, 0], up: [0, -1, 0] },
  { target: [0, 1, 0], up: [0, 0, 1] },
  { target: [0, -1, 0], up: [0, 0, -1] },
  { target: [0, 0, 1], up: [0, -1, 0] },
  { target: [0, 0, -1], up: [0, -1, 0] },
];

export interface CubemapCaptureOptions {
  faceSize?: number;
}

export class CubemapCapturePass {
  private device: GPUDevice;
  private faceSize: number;
  private cubemapTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;
  private skyDomePass: SkyDomePass;

  constructor(device: GPUDevice, options: CubemapCaptureOptions = {}) {
    this.device = device;
    this.faceSize = options.faceSize ?? 256;
    this.skyDomePass = new SkyDomePass(device, "rgba16float", 1);
    this.skyDomePass.prepare(device);
  }

  getCubemapTexture(): GPUTexture | null {
    return this.cubemapTexture;
  }

  capture(uniforms: Omit<SkyDomeUniforms, "viewProj" | "cameraPos">): GPUTexture {
    // Create a fresh cubemap texture each capture. The caller (IBLSystem) owns
    // the returned texture's lifecycle and defers destruction of the previous
    // cubemap until after the frame's command buffers have been submitted.
    // Reusing a single texture here would conflict with that deferred-destroy
    // contract — the next capture would render into a destroyed texture.
    this.cubemapTexture = this.device.createTexture({
      size: [this.faceSize, this.faceSize, 6],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    if (!this.depthTexture) {
      this.depthTexture = this.device.createTexture({
        size: [this.faceSize, this.faceSize],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    const proj = mat4.perspective(Math.PI / 2, 1.0, 0.1, 10000.0);

    // DEVIATION: This pass creates its own command encoder and submits per face
    // (6 submissions) instead of using the frame graph's shared encoder. This is
    // intentional — cubemap capture is a one-shot offline render that happens
    // outside the per-frame render loop, so it cannot share the frame encoder.
    for (let face = 0; face < 6; face++) {
      const faceView = this.cubemapTexture!.createView({
        dimension: "2d",
        baseArrayLayer: face,
        arrayLayerCount: 1,
      });

      const depthView = this.depthTexture!.createView();

      const encoder = this.device.createCommandEncoder();
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: faceView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });

      const view = mat4.lookAt([0, 0, 0], FACE_DIRS[face].target, FACE_DIRS[face].up);
      const viewProj = mat4.multiply(proj, view);

      this.skyDomePass.setUniforms({
        ...uniforms,
        viewProj: viewProj as Float32Array,
        cameraPos: [0, 0, 0],
      });

      const tracked = new TrackedRenderPass(renderPass);
      this.skyDomePass.execute({ device: this.device, pass: tracked } as any);
      tracked.end();

      this.device.queue.submit([encoder.finish()]);
    }

    return this.cubemapTexture;
  }

  destroy(): void {
    this.cubemapTexture?.destroy();
    this.depthTexture?.destroy();
    this.skyDomePass.destroy();
    this.cubemapTexture = null;
    this.depthTexture = null;
  }
}
