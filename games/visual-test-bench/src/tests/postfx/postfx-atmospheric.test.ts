// PostFX: Atmospheric — Grain + Lens Flare
import type { EffectId } from "@downdraft/core";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let grainEnabled = true;
let lensFlareEnabled = false;
let grainIntensity = 0.15;
let grainSize = 2.0;
let grainLuma = false;
let lensFlareIntensity = 0.8;
let lensFlareThreshold = 0.9;
let lensFlareGhosts = 8;
let lensFlareHalo = 0.2;
let rotationSpeed = 0.5;

const EFFECTS: EffectId[] = ["grain", "lens-flare"];

registerTest({
  id: "postfx-atm",
  name: "PostFX: Atmospheric",
  category: "PostFX",
  description: "Grain (animated film grain with luminance-aware mode) and Lens Flare (ghost streaks + halo from screen-space light position, depth-occluded).",
  requiresWebGPU: true,
  createRenderer: (canvas) => {
    const r = new PostfxTestRenderer(canvas, {
      effects: EFFECTS,
      needsNormals: () => false,
      needsVelocity: () => false,
      needsMask: () => false,
      useSelection: false,
      syncState: (stack) => {
        stack.setEnabled("grain", grainEnabled);
        stack.setEnabled("lens-flare", lensFlareEnabled);
        stack.setGrainIntensity(grainIntensity);
        stack.setGrainSize(grainSize);
        stack.setGrainLuminanceAware(grainLuma);
        stack.setLensFlareIntensity(lensFlareIntensity);
        stack.setLensFlareThreshold(lensFlareThreshold);
        stack.setLensFlareGhostCount(lensFlareGhosts);
        stack.setLensFlareHaloWidth(lensFlareHalo);
        // Light position orbits with the camera
        stack.setLightScreenPos(0.5 + Math.cos(0) * 0.3, 0.5);
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => grainEnabled || lensFlareEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "grn", label: "Grain", type: "checkbox", value: grainEnabled, onChange: (v) => { grainEnabled = v as boolean; } },
    { key: "grnI", label: "Grain intensity", type: "slider", min: 0, max: 0.5, step: 0.01, value: grainIntensity, onChange: (v) => { grainIntensity = v as number; } },
    { key: "grnS", label: "Grain size", type: "slider", min: 1, max: 8, step: 0.5, value: grainSize, onChange: (v) => { grainSize = v as number; } },
    { key: "grnL", label: "Grain luminance-aware", type: "checkbox", value: grainLuma, onChange: (v) => { grainLuma = v as boolean; } },
    { key: "lf", label: "Lens Flare", type: "checkbox", value: lensFlareEnabled, onChange: (v) => { lensFlareEnabled = v as boolean; } },
    { key: "lfI", label: "LF intensity", type: "slider", min: 0, max: 3, step: 0.05, value: lensFlareIntensity, onChange: (v) => { lensFlareIntensity = v as number; } },
    { key: "lfT", label: "LF threshold", type: "slider", min: 0, max: 2, step: 0.05, value: lensFlareThreshold, onChange: (v) => { lensFlareThreshold = v as number; } },
    { key: "lfG", label: "LF ghost count", type: "slider", min: 1, max: 16, step: 1, value: lensFlareGhosts, onChange: (v) => { lensFlareGhosts = v as number; } },
    { key: "lfH", label: "LF halo width", type: "slider", min: 0, max: 1, step: 0.05, value: lensFlareHalo, onChange: (v) => { lensFlareHalo = v as number; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
