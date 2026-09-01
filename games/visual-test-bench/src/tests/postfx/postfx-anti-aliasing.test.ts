// PostFX: Anti-Aliasing — TAA + FXAA
import type { EffectId } from "@downdraft/library-postfx";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let taaEnabled = false;
let fxaaEnabled = true;
let taaBlend = 0.1;
let taaVarianceClamp = false;
let taaJitterEnabled = false;
let jitterPhase = 0;
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
        stack.setTAAVarianceClamp(taaVarianceClamp);
        // Sub-pixel jitter (Halton sequence) for TAA convergence
        if (taaJitterEnabled && taaEnabled) {
          const halton = (index: number, base: number): number => {
            let f = 1, r = 0, i = index;
            while (i > 0) { f = f / base; r = r + f * (i % base); i = Math.floor(i / base); }
            return r - 0.5;
          };
          stack.setJitter(halton(jitterPhase + 1, 2), halton(jitterPhase + 1, 3));
          jitterPhase = (jitterPhase + 1) % 16;
        } else {
          stack.setJitter(0, 0);
        }
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => taaEnabled || fxaaEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "taa", label: "TAA", type: "checkbox", value: taaEnabled, onChange: (v) => { taaEnabled = v as boolean; } },
    { key: "taaBlend", label: "TAA blend factor", type: "slider", min: 0.01, max: 0.5, step: 0.01, value: taaBlend, onChange: (v) => { taaBlend = v as number; } },
    { key: "taaVC", label: "TAA variance clamp", type: "checkbox", value: taaVarianceClamp, onChange: (v) => { taaVarianceClamp = v as boolean; } },
    { key: "taaJ", label: "TAA jitter (Halton)", type: "checkbox", value: taaJitterEnabled, onChange: (v) => { taaJitterEnabled = v as boolean; } },
    { key: "fxaa", label: "FXAA", type: "checkbox", value: fxaaEnabled, onChange: (v) => { fxaaEnabled = v as boolean; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
