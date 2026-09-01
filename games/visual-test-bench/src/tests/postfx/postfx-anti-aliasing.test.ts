// PostFX: Anti-Aliasing — TAA + FXAA
import type { EffectId } from "@downdraft/core";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let taaEnabled = false;
let fxaaEnabled = true;
let taaBlend = 0.1;
let rotationSpeed = 0.5;

const EFFECTS: EffectId[] = ["taa", "fxaa"];

registerTest({
  id: "postfx-aa",
  name: "PostFX: Anti-Aliasing",
  category: "PostFX",
  description: "TAA (temporal anti-aliasing with velocity + history) and FXAA. TAA uses a YCoCg neighborhood clamp.",
  requiresWebGPU: true,
  createRenderer: (canvas) => {
    const r = new PostfxTestRenderer(canvas, {
      effects: EFFECTS,
      needsNormals: () => false,
      needsVelocity: () => taaEnabled,
      needsMask: () => false,
      useSelection: false,
      syncState: (stack) => {
        stack.setEnabled("taa", taaEnabled);
        stack.setEnabled("fxaa", fxaaEnabled);
        stack.setTAABlendFactor(taaBlend);
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => taaEnabled || fxaaEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "taa", label: "TAA", type: "checkbox", value: taaEnabled, onChange: (v) => { taaEnabled = v as boolean; } },
    { key: "taaBlend", label: "TAA blend factor", type: "slider", min: 0.01, max: 0.5, step: 0.01, value: taaBlend, onChange: (v) => { taaBlend = v as number; } },
    { key: "fxaa", label: "FXAA", type: "checkbox", value: fxaaEnabled, onChange: (v) => { fxaaEnabled = v as boolean; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
