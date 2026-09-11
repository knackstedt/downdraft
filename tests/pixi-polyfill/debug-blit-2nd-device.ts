// Test: render text via NativePixiUiHost using a SECOND device (like the game renderer).
// The game's 3D renderer creates its own adapter+device, separate from the host's.
// This test checks if the second device causes the half-alpha text issue.
import { NativePixiUiHost } from "@downdraft/library-pixi-ui-native";
import { createNativeHost, captureScreenshot } from "@downdraft/platform-native";
import { Graphics, Text } from "pixi.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const WIDTH = 512;
const HEIGHT = 512;

const host = await createNativeHost({
  window: { title: "Blit Test 2", width: 64, height: 64 },
});

// Create a SECOND adapter + device (like the game's 3D renderer does)
const gpu = (globalThis as any).navigator?.gpu;
const adapter2 = await gpu.requestAdapter({ powerPreference: "high-performance" });
const device2 = await adapter2.requestDevice({
  requiredFeatures: [],
  requiredLimits: {
    maxStorageBufferBindingSize: 64 * 1024 * 1024,
    maxStorageBuffersPerShaderStage: 8,
    maxSampledTexturesPerShaderStage: 16,
    maxTextureArrayLayers: 512,
  },
});
console.log(`host.device=${(host.device as any).ptr} device2=${(device2 as any).ptr} same=${host.device === device2}`);

// Create the PixiJS UI host using the SECOND device (like the game does)
const pixi = new NativePixiUiHost({
  device: device2,
  adapter: adapter2,
  targetFormat: "bgra8unorm",
  width: WIDTH,
  height: HEIGHT,
});

await pixi.ready;
console.log("PixiJS initialized on second device");

try {
  (pixi.renderer as any).background.color = 0x1a1a2e;
  (pixi.renderer as any).background.alpha = 1;
} catch (e) {
  console.log("warning:", e);
}

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

pixi.render();
console.log("PixiJS rendered");

const ctx = pixi.canvas.getWebgpuContext();
const uiTexture = ctx.getUiTexture();
if (!uiTexture) throw new Error("UI texture is null");
const format = (ctx.getFormat() as GPUTextureFormat) ?? "bgra8unorm";

mkdirSync(resolve("./tests/pixi-polyfill/artifacts"), { recursive: true });
captureScreenshot(device2, uiTexture, WIDTH, HEIGHT, "./tests/pixi-polyfill/artifacts/blit-test-2nd-device.png", format);
console.log("UI texture captured");

pixi.dispose();
host.destroy();
process.exit(0);
