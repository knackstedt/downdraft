// Test: create SDL2 window + wgpu surface, render a frame, present
import { installGPU } from "../gpu/install.ts";
import { NativeWindow } from "./native-window.ts";

// Install GPU
installGPU();

const gpu = (globalThis as any).navigator.gpu;

// Create native window
const win = new NativeWindow({ title: "Downdraft Native Test", width: 800, height: 600 });
console.log("Window created");

const surface = win.getSurface();
console.log("Surface:", surface.width, "x", surface.height);

// Get adapter + device
const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
const device = await adapter.requestDevice();
console.log("Device:", device.ptr);

// Configure surface context
const ctx = surface.getContext("webgpu")!;
ctx.configure({ device, format: "bgra8unorm", usage: 0x0010 });
console.log("Context configured");

// Create a simple shader
const shader = device.createShaderModule({
  code: `
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(0, -0.5), vec2f(-0.5, 0.5), vec2f(0.5, 0.5));
      return vec4f(p[i], 0, 1);
    }
    @fragment fn fs() -> @location(0) vec4f {
      return vec4f(1, 0, 0, 1);
    }
  `,
});

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shader, entryPoint: "vs" },
  fragment: { module: shader, entryPoint: "fs", targets: [{ format: "bgra8unorm" }] },
  primitive: { topology: "triangle-list" },
});
console.log("Pipeline created");

// Render a frame
let frameCount = 0;
const renderFrame = () => {
  const texture = ctx.getCurrentTexture();
  if (!texture) {
    console.log("No swapchain texture");
    return;
  }

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: texture.createView(),
      clearValue: { r: 0.1, g: 0.2, b: 0.3, a: 1.0 },
      loadOp: "clear",
      storeOp: "store",
    }],
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);

  ctx.present();
  frameCount++;
};

// Start event loop
win.start();
console.log("Event loop started");

// Render one frame and present
renderFrame();
console.log("Frame 1 rendered");

// Wait a bit, then render another frame
await new Promise(resolve => setTimeout(resolve, 100));
renderFrame();
console.log("Frame 2 rendered");

// Keep window open for 2 seconds
await new Promise(resolve => setTimeout(resolve, 2000));
console.log(`Rendered ${frameCount} frames total`);
win.destroy();
console.log("Window destroyed");
