import { GPUDeviceManager } from "./device.ts";
import { SurfaceManager } from "./surface.ts";
import { OpaquePass } from "./passes/opaque.ts";
import { TrackedRenderPass } from "./tracked-render-pass.ts";
import type { MeshData } from "../mesh/builder.ts";
import { Camera } from "../scene/camera.ts";
import { HighResTimer } from "../platform/time.ts";
import { TelemetryCollector } from "../telemetry/collector.ts";

const VERTEX_COLOR_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.color = input.color;
  output.normal = input.normal;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.5, 0.8, 0.3));
  let lambert = max(dot(normalize(input.normal), lightDir), 0.0);
  let ambient = 0.3;
  let intensity = ambient + lambert * 0.7;
  return vec4<f32>(input.color.rgb * intensity, input.color.a);
}
`;

export interface RenderLoopConfig {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  mesh: MeshData;
  camera: Camera;
  telemetry?: TelemetryCollector;
  clearColor?: { r: number; g: number; b: number; a: number };
}

export class RenderLoop {
  private deviceManager: GPUDeviceManager;
  private surface: SurfaceManager | null = null;
  private opaquePass: OpaquePass | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private cameraBindGroup: GPUBindGroup | null = null;
  private config: RenderLoopConfig;
  private timer: HighResTimer;
  private running: boolean = false;
  private rafId: number = 0;
  private width: number = 0;
  private height: number = 0;
  constructor(config: RenderLoopConfig) {
    this.deviceManager = new GPUDeviceManager();
    this.config = config;
    this.timer = new HighResTimer();
  }

  async init(): Promise<boolean> {
    const device = await this.deviceManager.requestDevice();
    if (!device) {
      console.error("[RenderLoop] Failed to get GPU device");
      return false;
    }

    this.surface = new SurfaceManager(device);
    this.surface.configure(this.config.canvas, {
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const surfaceFormat = this.surface.getFormat() ?? "bgra8unorm";
    this.opaquePass = new OpaquePass(device, surfaceFormat);
    this.opaquePass.setShaderSource(VERTEX_COLOR_SHADER);
    this.opaquePass.setMesh(this.config.mesh);
    this.opaquePass.prepare(device);

    // Camera uniform buffer
    this.cameraBuffer = device.createBuffer({
      size: 64, // mat4x4<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Cache bind group — created once after pipeline is ready
    const bindGroupLayout = this.opaquePass.getBindGroupLayout();
    if (bindGroupLayout) {
      this.cameraBindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
      });
    }

    const canvas = this.config.canvas;
    this.width = canvas.width;
    this.height = canvas.height;
    this.config.camera.setAspect(this.width, this.height);

    this.deviceManager.onDeviceLost(() => {
      console.warn("[RenderLoop] Device lost, attempting reinit...");
      this.handleDeviceLost();
    });

    return true;
  }

  private async handleDeviceLost(): Promise<void> {
    this.stop();
    const device = await this.deviceManager.reinit();
    if (device) {
      this.surface = new SurfaceManager(device);
      this.surface.configure(this.config.canvas);
      const surfaceFormat = this.surface.getFormat() ?? "bgra8unorm";
      this.opaquePass = new OpaquePass(device, surfaceFormat);
      this.opaquePass.setShaderSource(VERTEX_COLOR_SHADER);
      this.opaquePass.setMesh(this.config.mesh);
      this.opaquePass.prepare(device);
      this.cameraBuffer = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroupLayout = this.opaquePass.getBindGroupLayout();
      if (bindGroupLayout) {
        this.cameraBindGroup = device.createBindGroup({
          layout: bindGroupLayout,
          entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
        });
      }
      this.start();
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    this.render();
  };

  private render(): void {
    const device = this.deviceManager.getDevice();
    if (!device || !this.surface || !this.opaquePass || !this.cameraBindGroup) return;

    const dt = this.timer.delta();
    this.timer.tick(dt);

    // Update camera aspect only when dimensions change
    if (this.config.camera.aspect !== this.width / this.height) {
      this.config.camera.setAspect(this.width, this.height);
    }
    const viewProj = this.config.camera.getViewProjMatrix();
    device.queue.writeBuffer(this.cameraBuffer!, 0, viewProj as unknown as BufferSource);

    // Get current frame texture
    const texture = this.surface.getCurrentTexture();
    if (!texture) return;

    const depthTexture = this.opaquePass.ensureDepthTexture(this.width, this.height);
    if (!depthTexture) return;
    const depthView = depthTexture.createView();

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        clearValue: this.config.clearColor ?? { r: 0.1, g: 0.1, b: 0.12, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    // Use a single TrackedRenderPass for the entire frame
    const tracked = new TrackedRenderPass(pass);
    tracked.setBindGroup(0, this.cameraBindGroup);
    this.opaquePass.execute({ device, pass: tracked });
    tracked.end();

    device.queue.submit([encoder.finish()]);

    if (this.config.telemetry) {
      this.config.telemetry.recordFrame(dt * 1000);
    }
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.surface?.reconfigure(width, height);
    this.config.camera.setAspect(width, height);
  }

  isRunning(): boolean {
    return this.running;
  }

  getDeviceManager(): GPUDeviceManager {
    return this.deviceManager;
  }
}
