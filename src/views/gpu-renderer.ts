// Minimal WebGPU renderer: animated clear color + rotating triangle
// Uses navigator.gpu (CEF + Dawn provides WebGPU support)

export class GPURenderer {
  private canvas: HTMLCanvasElement;
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private pipeline!: GPURenderPipeline;
  private rafId = 0;
  private startTime = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init(): Promise<boolean> {
    console.log("[GPU] Checking navigator.gpu...");
    if (!navigator.gpu) {
      console.error("[GPU] WebGPU not available - navigator.gpu is undefined, falling back to 2D canvas");
      this.init2DFallback();
      return true;
    }
    console.log("[GPU] navigator.gpu found, requesting adapter...");

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      console.error("[GPU] No adapter found, falling back to 2D canvas");
      this.init2DFallback();
      return true;
    }
    console.log("[GPU] Adapter found:", adapter.info || "unknown");

    try {
      this.device = await adapter.requestDevice();
      console.log("[GPU] Device acquired");

      const ctx = this.canvas.getContext("webgpu");
      if (!ctx) {
        console.error("[GPU] Canvas getContext('webgpu') returned null, falling back to 2D canvas");
        this.init2DFallback();
        return true;
      }
      this.context = ctx;
      console.log("[GPU] Canvas context acquired");

    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format,
      alphaMode: "opaque",
    });

    // Simple triangle shader
    const shader = this.device.createShaderModule({
      code: `
        struct Uniforms {
          time: f32,
          _pad: f32,
          _pad2: f32,
          _pad3: f32,
        };

        @group(0) @binding(0) var<uniform> u: Uniforms;

        @vertex
        fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {
          var positions = array<vec2f, 3>(
            vec2f(0.0, 0.5),
            vec2f(-0.5, -0.5),
            vec2f(0.5, -0.5),
          );
          let pos = positions[idx];
          let angle = u.time * 0.5;
          let cos_a = cos(angle);
          let sin_a = sin(angle);
            let rotated = vec2f(
            pos.x * cos_a - pos.y * sin_a,
            pos.x * sin_a + pos.y * cos_a,
          );
          return vec4f(rotated, 0.0, 1.0);
        }

        @fragment
        fn fs_main() -> @location(0) vec4f {
          let t = u.time;
          return vec4f(
            0.5 + 0.5 * sin(t),
            0.5 + 0.5 * sin(t + 2.0),
            0.5 + 0.5 * sin(t + 4.0),
            1.0,
          );
        }
      `,
    });

    const uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = this.device.createBindGroup({
      layout: this.device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          },
        ],
      }),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [bindGroup.layout],
      }),
      vertex: {
        module: shader,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });

    // Store for render loop
    (this as any)._uniformBuffer = uniformBuffer;
    (this as any)._bindGroup = bindGroup;

    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.render();

    console.log("[GPU] WebGPU renderer initialized");
    return true;
    } catch (err) {
      console.error("[GPU] WebGPU init failed, falling back to 2D canvas:", err);
      this.init2DFallback();
      return true;
    }
  }

  init2DFallback() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    const render2d = () => {
      const time = (performance.now() - this.startTime) / 1000;
      const w = this.canvas.width;
      const h = this.canvas.height;
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, `hsl(${(time * 30) % 360}, 70%, 15%)`);
      grad.addColorStop(0.5, `hsl(${(time * 30 + 60) % 360}, 70%, 10%)`);
      grad.addColorStop(1, `hsl(${(time * 30 + 120) % 360}, 70%, 5%)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Draw rotating triangle
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(time * 0.5);
      const size = Math.min(w, h) * 0.15;
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(-size, size);
      ctx.lineTo(size, size);
      ctx.closePath();
      ctx.fillStyle = `hsl(${(time * 60) % 360}, 80%, 60%)`;
      ctx.fill();
      ctx.restore();

      this.rafId = requestAnimationFrame(render2d);
    };
    render2d();
    console.log("[GPU] 2D canvas fallback initialized");
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
  }

  render = () => {
    const time = (performance.now() - this.startTime) / 1000;
    const uniformBuffer = (this as any)._uniformBuffer as GPUBuffer;
    const bindGroup = (this as any)._bindGroup as GPUBindGroup;

    // Update uniform
    this.device.queue.writeBuffer(
      uniformBuffer,
      0,
      new Float32Array([time, 0, 0, 0]),
    );

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.02, g: 0.02, b: 0.04, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
    this.rafId = requestAnimationFrame(this.render);
  };

  stop() {
    cancelAnimationFrame(this.rafId);
    this.device?.destroy();
  }
}
