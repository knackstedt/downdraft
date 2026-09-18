// Test: render text via NativePixiUiHost, blit to a separate texture, capture.
// Isolates whether the blit pass correctly composites text.
import { NativePixiUiHost } from "@downdraft/engine/libraries/pixi-ui-native";
import { captureScreenshot, createNativeHost } from "@downdraft/platform-native";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Graphics, Text } from "pixi.js";

const WIDTH = 512;
const HEIGHT = 512;

const host = await createNativeHost({
  window: { title: "Blit Test", width: 64, height: 64 },
});

const { device, adapter } = host;

// Create the PixiJS UI host
const pixi = new NativePixiUiHost({
  device,
  adapter,
  targetFormat: "bgra8unorm",
  width: WIDTH,
  height: HEIGHT,
});

await pixi.ready;
console.log("PixiJS initialized");

// Set opaque dark background
try {
  (pixi.renderer as any).background.color = 0x1a1a2e;
  (pixi.renderer as any).background.alpha = 1;
} catch (e) {
  console.log("warning: could not set background:", e);
}

// Add a red rectangle AND text to the stage
const rect = new Graphics();
rect.rect(50, 50, 200, 50);
rect.fill({ color: 0xff0000, alpha: 1 });
pixi.stage.addChild(rect);

const text = new Text({
  text: "HELLO WORLD",
  style: { fontSize: 32, fill: 0xffff00, fontFamily: "monospace" },
});
text.x = 50;
text.y = 120;
pixi.stage.addChild(text);

const text2 = new Text({
  text: "Text Rendering Test",
  style: { fontSize: 20, fill: 0x00ff00, fontFamily: "sans-serif" },
});
text2.x = 50;
text2.y = 180;
pixi.stage.addChild(text2);

// Render the PixiJS scene into the UI texture
pixi.render();
console.log("PixiJS rendered");

// Capture the UI texture directly (like the parity test)
const ctx = pixi.canvas.getWebgpuContext();
const uiTexture = ctx.getUiTexture();
if (!uiTexture) throw new Error("UI texture is null");
const format = (ctx.getFormat() as GPUTextureFormat) ?? "bgra8unorm";

mkdirSync(resolve("./tests/pixi-polyfill/artifacts"), { recursive: true });
captureScreenshot(device, uiTexture, WIDTH, HEIGHT, "./tests/pixi-polyfill/artifacts/blit-test-ui.png", format);
console.log("UI texture captured");

// Now blit to a separate render target texture and capture that
const blitTarget = device.createTexture({
  size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  format: "bgra8unorm",
  usage: 0x0010 | 0x0002 | 0x0001, // RENDER_ATTACHMENT | COPY_DST | COPY_SRC
});

const uiView = pixi.getUiTextureView();
if (!uiView) throw new Error("No UI texture view");

const blitTargetView = blitTarget.createView();
const encoder = device.createCommandEncoder();
pixi.blitPass.execute(encoder, blitTargetView, uiView);
device.queue.submit([encoder.finish()]);
console.log("Blit executed");

captureScreenshot(device, blitTarget, WIDTH, HEIGHT, "./tests/pixi-polyfill/artifacts/blit-test-result.png", "bgra8unorm");
console.log("Blit result captured");

blitTarget.destroy();
pixi.dispose();
host.destroy();
process.exit(0);
