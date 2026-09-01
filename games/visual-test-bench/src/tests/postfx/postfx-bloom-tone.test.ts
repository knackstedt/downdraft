// PostFX: Bloom & Tonemap — Bloom + Bloom-Soft + Tonemap
import type { EffectId } from "@downdraft/core";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let bloomEnabled = true;
let bloomSoftEnabled = false;
let tonemapEnabled = true;
let bloomThreshold = 0.8;
let bloomStrength = 1.0;
let bloomSoftThreshold = 1.0;
let bloomSoftIntensity = 0.3;
let exposure = 1.0;
let gamma = 2.2;
let contrast = 1.0;
let saturation = 1.0;
let vignette = 0.3;
let rotationSpeed = 0.5;

const EFFECTS: EffectId[] = ["bloom", "bloom-soft", "tonemap"];

registerTest({
  id: "postfx-bloom",
  name: "PostFX: Bloom & Tonemap",
  category: "PostFX",
  description: "Bloom (bright-pass + separable blur + composite), Bloom-Soft (soft threshold variant, composited via tonemap), and Tonemap (ACES + exposure/gamma/contrast/saturation/vignette). HDR pipeline.",
  requiresWebGPU: true,
  createRenderer: (canvas) => {
    const r = new PostfxTestRenderer(canvas, {
      effects: EFFECTS,
      needsNormals: () => false,
      needsVelocity: () => false,
      needsMask: () => false,
      useSelection: false,
      syncState: (stack) => {
        stack.setEnabled("bloom", bloomEnabled);
        stack.setEnabled("bloom-soft", bloomSoftEnabled);
        stack.setEnabled("tonemap", tonemapEnabled);
        stack.setBloomThreshold(bloomThreshold);
        stack.setBloomStrength(bloomStrength);
        stack.setBloomSoftThreshold(bloomSoftThreshold);
        stack.setBloomSoftIntensity(bloomSoftIntensity);
        stack.setExposure(exposure);
        stack.setGamma(gamma);
        stack.setContrast(contrast);
        stack.setSaturation(saturation);
        stack.setVignette(vignette);
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => bloomEnabled || bloomSoftEnabled || tonemapEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "bloom", label: "Bloom", type: "checkbox", value: bloomEnabled, onChange: (v) => { bloomEnabled = v as boolean; } },
    { key: "bT", label: "Bloom threshold", type: "slider", min: 0, max: 2, step: 0.05, value: bloomThreshold, onChange: (v) => { bloomThreshold = v as number; } },
    { key: "bS", label: "Bloom strength", type: "slider", min: 0, max: 3, step: 0.05, value: bloomStrength, onChange: (v) => { bloomStrength = v as number; } },
    { key: "bs", label: "Bloom-Soft", type: "checkbox", value: bloomSoftEnabled, onChange: (v) => { bloomSoftEnabled = v as boolean; } },
    { key: "bsT", label: "Bloom-Soft threshold", type: "slider", min: 0, max: 3, step: 0.05, value: bloomSoftThreshold, onChange: (v) => { bloomSoftThreshold = v as number; } },
    { key: "bsI", label: "Bloom-Soft intensity", type: "slider", min: 0, max: 2, step: 0.05, value: bloomSoftIntensity, onChange: (v) => { bloomSoftIntensity = v as number; } },
    { key: "tm", label: "Tonemap", type: "checkbox", value: tonemapEnabled, onChange: (v) => { tonemapEnabled = v as boolean; } },
    { key: "exp", label: "Exposure", type: "slider", min: 0, max: 4, step: 0.05, value: exposure, onChange: (v) => { exposure = v as number; } },
    { key: "gam", label: "Gamma", type: "slider", min: 1, max: 3, step: 0.05, value: gamma, onChange: (v) => { gamma = v as number; } },
    { key: "con", label: "Contrast", type: "slider", min: 0.5, max: 2, step: 0.05, value: contrast, onChange: (v) => { contrast = v as number; } },
    { key: "sat", label: "Saturation", type: "slider", min: 0, max: 2, step: 0.05, value: saturation, onChange: (v) => { saturation = v as number; } },
    { key: "vig", label: "Vignette", type: "slider", min: 0, max: 1, step: 0.05, value: vignette, onChange: (v) => { vignette = v as number; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
