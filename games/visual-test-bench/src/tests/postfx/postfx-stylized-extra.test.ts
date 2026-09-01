// PostFX: Stylized Extra — Halftone + Dithering + Watercolor
import type { EffectId } from "@downdraft/library-postfx";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let halftoneEnabled = true;
let ditheringEnabled = false;
let watercolorEnabled = false;
let htCellSize = 8;
let htDotScale = 1.0;
let htAngle = 0.0;
let htMonochrome = true;
let dMode = 1;       // 0=off, 1=bayer, 2=bluenoise
let dStrength = 0.5;
let dLevels = 0;
let wcEdgeStrength = 1.0;
let wcPaperScale = 2.0;
let wcBlend = 0.7;
let rotationSpeed = 0.5;

const EFFECTS: EffectId[] = ["tonemap", "halftone", "dithering", "watercolor"];

registerTest({
  id: "postfx-stylized-extra",
  name: "PostFX: Stylized Extra",
  category: "PostFX",
  description: "Halftone (dot/hex cell pattern with monochrome/CMYK color modes), dithering (Bayer 4x4 + blue-noise with optional quantization), and watercolor (edge-aware smoothing + paper texture blend for a hand-painted look).",
  requiresWebGPU: true,
  createRenderer: (canvas) => {
    const r = new PostfxTestRenderer(canvas, {
      effects: EFFECTS,
      needsNormals: () => false,
      needsVelocity: () => false,
      needsMask: () => false,
      useSelection: false,
      syncState: (stack) => {
        stack.setEnabled("tonemap", true);
        stack.setEnabled("halftone", halftoneEnabled);
        stack.setEnabled("dithering", ditheringEnabled);
        stack.setEnabled("watercolor", watercolorEnabled);
        stack.setHalftone(htCellSize, htDotScale, htAngle, htMonochrome);
        stack.setDithering(dMode, dStrength, dLevels);
        stack.setWatercolor(wcEdgeStrength, wcPaperScale, wcBlend);
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => halftoneEnabled || ditheringEnabled || watercolorEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "ht", label: "Halftone", type: "checkbox", value: halftoneEnabled, onChange: (v) => { halftoneEnabled = v as boolean; } },
    { key: "htC", label: "HT Cell Size", type: "slider", min: 2, max: 32, step: 1, value: htCellSize, onChange: (v) => { htCellSize = v as number; } },
    { key: "htD", label: "HT Dot Scale", type: "slider", min: 0.1, max: 2, step: 0.05, value: htDotScale, onChange: (v) => { htDotScale = v as number; } },
    { key: "htA", label: "HT Angle", type: "slider", min: 0, max: 6.28, step: 0.1, value: htAngle, onChange: (v) => { htAngle = v as number; } },
    { key: "htM", label: "HT Monochrome", type: "checkbox", value: htMonochrome, onChange: (v) => { htMonochrome = v as boolean; } },
    { key: "di", label: "Dithering", type: "checkbox", value: ditheringEnabled, onChange: (v) => { ditheringEnabled = v as boolean; } },
    { key: "diM", label: "D Mode (1=Bayer,2=Noise)", type: "slider", min: 0, max: 2, step: 1, value: dMode, onChange: (v) => { dMode = v as number; } },
    { key: "diS", label: "D Strength", type: "slider", min: 0, max: 1, step: 0.05, value: dStrength, onChange: (v) => { dStrength = v as number; } },
    { key: "diL", label: "D Levels (0=off)", type: "slider", min: 0, max: 64, step: 1, value: dLevels, onChange: (v) => { dLevels = v as number; } },
    { key: "wc", label: "Watercolor", type: "checkbox", value: watercolorEnabled, onChange: (v) => { watercolorEnabled = v as boolean; } },
    { key: "wcE", label: "WC Edge Strength", type: "slider", min: 0, max: 2, step: 0.05, value: wcEdgeStrength, onChange: (v) => { wcEdgeStrength = v as number; } },
    { key: "wcP", label: "WC Paper Scale", type: "slider", min: 1, max: 10, step: 0.5, value: wcPaperScale, onChange: (v) => { wcPaperScale = v as number; } },
    { key: "wcB", label: "WC Blend", type: "slider", min: 0, max: 1, step: 0.05, value: wcBlend, onChange: (v) => { wcBlend = v as number; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
