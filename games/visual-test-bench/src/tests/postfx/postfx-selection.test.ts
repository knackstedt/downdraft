// PostFX: Selection FX — Outline + Highlight + Glow + Afterimage
import type { EffectId } from "@downdraft/core";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let outlineEnabled = true;
let highlightEnabled = false;
let glowEnabled = false;
let afterimageEnabled = false;
let outlineWidth = 2.0;
let outlineOpacity = 1.0;
let highlightIntensity = 0.8;
let highlightBlurRadius = 3.0;
let glowIntensity = 1.0;
let glowBlurRadius = 4.0;
let afterimageDamp = 0.96;
let rotationSpeed = 0.5;

const EFFECTS: EffectId[] = ["outline", "highlight", "glow", "afterimage"];

registerTest({
  id: "postfx-sel",
  name: "PostFX: Selection FX",
  category: "PostFX",
  description: "Outline (silhouette edge from object-id mask), Highlight (blurred mask overlay), Glow (blurred mask additive bloom), and Afterimage (temporal trail accumulation). Pre-selected cubes demonstrate mask-based effects.",
  requiresWebGPU: true,
  createRenderer: (canvas) => {
    const r = new PostfxTestRenderer(canvas, {
      effects: EFFECTS,
      needsNormals: () => false,
      needsVelocity: () => false,
      needsMask: () => outlineEnabled || highlightEnabled || glowEnabled,
      useSelection: true,
      syncState: (stack) => {
        stack.setEnabled("outline", outlineEnabled);
        stack.setEnabled("highlight", highlightEnabled);
        stack.setEnabled("glow", glowEnabled);
        stack.setEnabled("afterimage", afterimageEnabled);
        stack.setOutlineWidth(outlineWidth);
        stack.setOutlineOpacity(outlineOpacity);
        stack.setHighlightIntensity(highlightIntensity);
        stack.setHighlightBlurRadius(highlightBlurRadius);
        stack.setGlowIntensity(glowIntensity);
        stack.setGlowBlurRadius(glowBlurRadius);
        stack.setAfterimageDamp(afterimageDamp);
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => outlineEnabled || highlightEnabled || glowEnabled || afterimageEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "out", label: "Outline", type: "checkbox", value: outlineEnabled, onChange: (v) => { outlineEnabled = v as boolean; } },
    { key: "outW", label: "Outline width", type: "slider", min: 1, max: 8, step: 0.5, value: outlineWidth, onChange: (v) => { outlineWidth = v as number; } },
    { key: "outO", label: "Outline opacity", type: "slider", min: 0, max: 1, step: 0.05, value: outlineOpacity, onChange: (v) => { outlineOpacity = v as number; } },
    { key: "hl", label: "Highlight", type: "checkbox", value: highlightEnabled, onChange: (v) => { highlightEnabled = v as boolean; } },
    { key: "hlI", label: "Highlight intensity", type: "slider", min: 0, max: 3, step: 0.05, value: highlightIntensity, onChange: (v) => { highlightIntensity = v as number; } },
    { key: "hlB", label: "Highlight blur", type: "slider", min: 1, max: 10, step: 0.5, value: highlightBlurRadius, onChange: (v) => { highlightBlurRadius = v as number; } },
    { key: "gl", label: "Glow", type: "checkbox", value: glowEnabled, onChange: (v) => { glowEnabled = v as boolean; } },
    { key: "glI", label: "Glow intensity", type: "slider", min: 0, max: 3, step: 0.05, value: glowIntensity, onChange: (v) => { glowIntensity = v as number; } },
    { key: "glB", label: "Glow blur", type: "slider", min: 1, max: 12, step: 0.5, value: glowBlurRadius, onChange: (v) => { glowBlurRadius = v as number; } },
    { key: "ai", label: "Afterimage", type: "checkbox", value: afterimageEnabled, onChange: (v) => { afterimageEnabled = v as boolean; } },
    { key: "aiD", label: "Afterimage damping", type: "slider", min: 0, max: 0.99, step: 0.01, value: afterimageDamp, onChange: (v) => { afterimageDamp = v as number; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
