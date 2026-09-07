// Test: create device, buffer, shader, pipeline, and submit a draw call
import { installGPU } from "./install.ts";

installGPU();

const gpu = (globalThis as any).navigator.gpu;
console.log("GPU:", gpu);
console.log("Preferred format:", gpu.getPreferredCanvasFormat());

const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
console.log("Adapter:", adapter);

const device = await adapter.requestDevice({
  requiredLimits: {
    maxStorageBufferBindingSize: 64 * 1024 * 1024,
    maxStorageBuffersPerShaderStage: 8,
    maxSampledTexturesPerShaderStage: 16,
  },
});
console.log("Device:", device);
console.log("Queue:", device.queue);

// Create a vertex buffer
const vertexData = new Float32Array([
  0.0,  0.5, 0.0, 1.0,  1.0, 0.0, 0.0, 1.0,
 -0.5, -0.5, 0.0, 1.0,  0.0, 1.0, 0.0, 1.0,
  0.5, -0.5, 0.0, 1.0,  0.0, 0.0, 1.0, 1.0,
]);
const vertexBuffer = device.createBuffer({
  size: vertexData.byteLength,
  usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
});
console.log("Vertex buffer:", vertexBuffer);
device.queue.writeBuffer(vertexBuffer, 0, vertexData);
console.log("Vertex buffer written");

// Create a render target texture (since we don't have a window yet)
const renderTarget = device.createTexture({
  size: { width: 800, height: 600 },
  format: "bgra8unorm",
  usage: 0x0010 | 0x0002, // RENDER_ATTACHMENT | COPY_SRC
});
console.log("Render target:", renderTarget);
const renderTargetView = renderTarget.createView();
console.log("Render target view:", renderTargetView);

// Create a depth texture
const depthTexture = device.createTexture({
  size: { width: 800, height: 600 },
  format: "depth24plus",
  usage: 0x0010, // RENDER_ATTACHMENT
});
const depthView = depthTexture.createView();

// Create shader
const shader = device.createShaderModule({
  code: `
    struct VSOut {
      @builtin(position) pos: vec4f,
      @location(0) color: vec4f,
    };

    @vertex
    fn vs_main(@location(0) pos: vec4f, @location(1) col: vec4f) -> VSOut {
      var out: VSOut;
      out.pos = pos;
      out.color = col;
      return out;
    }

    @fragment
    fn fs_main(in: VSOut) -> @location(0) vec4f {
      return in.color;
    }
  `,
});
console.log("Shader:", shader);

// Create render pipeline
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: {
    module: shader,
    entryPoint: "vs_main",
    buffers: [{
      arrayStride: 32, // 8 floats * 4 bytes
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x4" },   // position
        { shaderLocation: 1, offset: 16, format: "float32x4" },  // color
      ],
    }],
  },
  fragment: {
    module: shader,
    entryPoint: "fs_main",
    targets: [{ format: "bgra8unorm" }],
  },
  primitive: { topology: "triangle-list" },
  depthStencil: {
    format: "depth24plus",
    depthWriteEnabled: true,
    depthCompare: "less",
  },
});
console.log("Pipeline:", pipeline);

// Render a frame
const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: renderTargetView,
    clearValue: { r: 0.1, g: 0.2, b: 0.3, a: 1.0 },
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
pass.setPipeline(pipeline);
pass.setVertexBuffer(0, vertexBuffer);
pass.draw(3);
pass.end();
const cmdBuffer = encoder.finish();
console.log("Command buffer:", cmdBuffer);
device.queue.submit([cmdBuffer]);
console.log("Submitted!");

console.log("\n✅ Full render pipeline works: device → buffer → shader → pipeline → render pass → draw → submit");
