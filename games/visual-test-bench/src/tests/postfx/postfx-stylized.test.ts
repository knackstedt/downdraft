// PostFX: Stylized — Pixelation + Gaussian Blur + ASCII
import type { EffectId } from "@downdraft/library-postfx";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let pixelationEnabled = true;
let gaussianBlurEnabled = false;
let asciiEnabled = false;
let pixelSize = 6;
let depthEdgeStrength = 0.4;
let gaussianBlurRadius = 2.0;
let asciiCellSize = 8;
let asciiUseColor = false;
let rotationSpeed = 0.5;

const EFFECTS: EffectId[] = ["pixelation", "gaussian-blur", "ascii"];

registerTest({
  id: "postfx-style",
  name: "PostFX: Stylized",
  category: "PostFX",
  description: "Pixelation (blocky UV quantization + depth edge detection), Gaussian Blur (two-pass separable, normalized kernel), and ASCII rendering (glyph atlas mapping).",
  requiresWebGPU: true,
  createRenderer: (canvas) => {
    const r = new PostfxTestRenderer(canvas, {
      effects: EFFECTS,
      needsNormals: () => false,
      needsVelocity: () => false,
      needsMask: () => false,
      useSelection: false,
      syncState: (stack) => {
        stack.setEnabled("pixelation", pixelationEnabled);
        stack.setEnabled("gaussian-blur", gaussianBlurEnabled);
        stack.setEnabled("ascii", asciiEnabled);
        stack.setPixelationPixelSize(pixelSize);
        stack.setPixelationDepthEdgeStrength(depthEdgeStrength);
        stack.setGaussianBlurRadius(gaussianBlurRadius);
        stack.setASCIICellSize(asciiCellSize);
        stack.setASCIIUseColor(asciiUseColor);
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => pixelationEnabled || gaussianBlurEnabled || asciiEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "pix", label: "Pixelation", type: "checkbox", value: pixelationEnabled, onChange: (v) => { pixelationEnabled = v as boolean; } },
    { key: "pixS", label: "Pixel size", type: "slider", min: 2, max: 32, step: 1, value: pixelSize, onChange: (v) => { pixelSize = v as number; } },
    { key: "pixE", label: "Depth edge strength", type: "slider", min: 0, max: 1, step: 0.05, value: depthEdgeStrength, onChange: (v) => { depthEdgeStrength = v as number; } },
    { key: "gb", label: "Gaussian Blur", type: "checkbox", value: gaussianBlurEnabled, onChange: (v) => { gaussianBlurEnabled = v as boolean; } },
    { key: "gbR", label: "Blur radius", type: "slider", min: 0.5, max: 10, step: 0.5, value: gaussianBlurRadius, onChange: (v) => { gaussianBlurRadius = v as number; } },
    { key: "asc", label: "ASCII", type: "checkbox", value: asciiEnabled, onChange: (v) => { asciiEnabled = v as boolean; } },
    { key: "ascC", label: "ASCII cell size", type: "slider", min: 2, max: 32, step: 1, value: asciiCellSize, onChange: (v) => { asciiCellSize = v as number; } },
    { key: "ascCol", label: "ASCII color", type: "checkbox", value: asciiUseColor, onChange: (v) => { asciiUseColor = v as boolean; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
