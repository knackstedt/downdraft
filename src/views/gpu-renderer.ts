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
    // Use 2D canvas directly — WebGPU in CEF on Linux needs more setup
    this.init2DFallback();
    return true;
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
