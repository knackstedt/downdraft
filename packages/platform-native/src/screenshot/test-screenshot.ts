// ============================================================================
// test-screenshot.ts — End-to-end native screenshot test
//
// Creates a native window, renders a colored triangle with wgpu-native,
// captures the framebuffer, and saves it as a PNG file.
//
// This is the acceptance test for the native GPU pipeline.
// ============================================================================

import { createNativeHost } from "../native-host";

const host = await createNativeHost({
  window: { title: "Downdraft Native Screenshot Test", width: 800, height: 600 },
  screenshotPath: "./native-screenshot.png",
  screenshotAfterFrames: 1,
});

const { device, surface, captureScreenshot } = host;
const ctx = surface.getContext("webgpu")!;
const format = host.gpu.getPreferredCanvasFormat();

// Create a triangle shader
const shader = device.createShaderModule({
  code: `
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(
        vec2f(0.0, -0.5),
        vec2f(-0.5, 0.5),
        vec2f(0.5, 0.5)
      );
      return vec4f(p[i], 0.0, 1.0);
    }

    @fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
      // Create a gradient based on position
      let r = pos.x / 800.0;
      let g = pos.y / 600.0;
      let b = 0.5 + 0.5 * sin(pos.x * 0.01);
      return vec4f(r, g, b, 1.0);
    }
  `,
});

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shader, entryPoint: "vs" },
  fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
  primitive: { topology: "triangle-list" },
});

console.log("Pipeline created, rendering frame...");

// Render one frame
const texture = ctx.getCurrentTexture();
if (!texture) {
  console.error("Failed to get swapchain texture");
  host.destroy();
  process.exit(1);
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

// Capture screenshot before presenting
const screenshotPath = "./native-screenshot.png";
captureScreenshot(screenshotPath, texture);

// Present the frame
ctx.present();

console.log(`Screenshot saved to ${screenshotPath}`);
console.log("Keeping window open for 2 seconds...");

// Keep window open briefly
await new Promise(resolve => setTimeout(resolve, 2000));
host.destroy();
console.log("Done!");
