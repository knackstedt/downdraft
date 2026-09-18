// Test: reproduce the half-bright rendering bug with backgroundAlpha: 0.
// The full game uses backgroundAlpha: 0 (transparent); the working harness
// sets background.alpha = 1 AFTER init. This test uses backgroundAlpha: 0
// throughout to match the full game and check if the rect renders half-bright.
import { NativePixiUiHost } from "@downdraft/engine/libraries/pixi-ui-native";
import { captureScreenshot, createNativeHost } from "@downdraft/platform-native";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Graphics, Text } from "pixi.js";

const WIDTH = 512;
const HEIGHT = 512;

const host = await createNativeHost({
  window: { title: "Blit Test Transparent", width: 64, height: 64 },
});

const { device, adapter } = host;

// Create the PixiJS UI host — backgroundAlpha: 0 like the full game.
const pixi = new NativePixiUiHost({
  device,
  adapter,
  targetFormat: "bgra8unorm",
  width: WIDTH,
  height: HEIGHT,
});

await pixi.ready;
console.log("PixiJS initialized (backgroundAlpha: 0)");

// Log the transparent flag + alphaMode
try {
  const view = (pixi.renderer as any).view;
  const src = view?.texture?.source;
  console.log(`source.transparent=${src?.transparent} backgroundAlpha=${(pixi.renderer as any).background?.alpha}`);
} catch (e) { console.log("log error:", e); }

// Add a red rectangle AND text — NO opaque background (transparent, like full game).
const rect = new Graphics();
rect.rect(50, 50, 200, 50);
rect.fill({ color: 0xff00ff, alpha: 1 });
pixi.stage.addChild(rect);

const text = new Text({
  text: "HELLO WORLD",
  style: { fontSize: 32, fill: 0xffff00, fontFamily: "monospace" },
});
text.x = 50;
text.y = 120;
pixi.stage.addChild(text);

// Render the PixiJS scene into the UI texture
pixi.render();
console.log("PixiJS rendered");

// Capture the UI texture directly
const ctx = pixi.canvas.getWebgpuContext();
const uiTexture = ctx.getUiTexture();
if (!uiTexture) throw new Error("UI texture is null");
const format = (ctx.getFormat() as GPUTextureFormat) ?? "bgra8unorm";

mkdirSync(resolve("./tests/pixi-polyfill/artifacts"), { recursive: true });
captureScreenshot(device, uiTexture, WIDTH, HEIGHT, "./tests/pixi-polyfill/artifacts/blit-test-transparent-ui.png", format);
console.log("UI texture captured");

// Now blit to a separate render target texture and capture that
const blitTarget = device.createTexture({
  size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  format: "bgra8unorm",
  usage: 0x0010 | 0x0002 | 0x0001, // RENDER_ATTACHMENT | COPY_DST | COPY_SRC
});

// Clear blit target to a dark color so we can see the blit
const clearEnc = device.createCommandEncoder();
const clearPass = clearEnc.beginRenderPass({
  colorAttachments: [{ view: blitTarget.createView(), clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1 }, loadOp: "clear", storeOp: "store" }],
});
clearPass.end();
device.queue.submit([clearEnc.finish()]);

const uiView = pixi.getUiTextureView();
if (!uiView) throw new Error("No UI texture view");

const blitTargetView = blitTarget.createView();
const encoder = device.createCommandEncoder();
pixi.blitPass.execute(encoder, blitTargetView, uiView);
device.queue.submit([encoder.finish()]);
console.log("Blit executed");

captureScreenshot(device, blitTarget, WIDTH, HEIGHT, "./tests/pixi-polyfill/artifacts/blit-test-transparent-result.png", "bgra8unorm");
console.log("Blit result captured");

blitTarget.destroy();
pixi.dispose();
host.destroy();
process.exit(0);
