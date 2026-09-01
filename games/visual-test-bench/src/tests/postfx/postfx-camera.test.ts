// PostFX: Camera — DOF + Motion Blur
import type { EffectId } from "@downdraft/core";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let dofEnabled = true;
let motionBlurEnabled = false;
let dofFocusDist = 0.5;
let dofFocusRange = 0.3;
let dofMaxBlur = 8;
let motionBlurIntensity = 1.0;
let motionBlurSamples = 16;
let rotationSpeed = 0.5;

const EFFECTS: EffectId[] = ["dof", "motion-blur"];

registerTest({
  id: "postfx-cam",
  name: "PostFX: Camera",
  category: "PostFX",
  description: "Depth of Field (circle of confusion blur based on depth) and Motion Blur (velocity-based blur). Motion blur uses velocity MRT.",
  requiresWebGPU: true,
  createRenderer: (canvas) => {
    const r = new PostfxTestRenderer(canvas, {
      effects: EFFECTS,
      needsNormals: () => false,
      needsVelocity: () => motionBlurEnabled,
      needsMask: () => false,
      useSelection: false,
      syncState: (stack) => {
        stack.setEnabled("dof", dofEnabled);
        stack.setEnabled("motion-blur", motionBlurEnabled);
        stack.setDOFFocusDist(dofFocusDist);
        stack.setDOFFocusRange(dofFocusRange);
        stack.setDOFMaxBlur(dofMaxBlur);
        stack.setMotionBlurIntensity(motionBlurIntensity);
        stack.setMotionBlurMaxSamples(motionBlurSamples);
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => dofEnabled || motionBlurEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "dof", label: "Depth of Field", type: "checkbox", value: dofEnabled, onChange: (v) => { dofEnabled = v as boolean; } },
    { key: "dofF", label: "DOF focus distance", type: "slider", min: 0, max: 1, step: 0.01, value: dofFocusDist, onChange: (v) => { dofFocusDist = v as number; } },
    { key: "dofR", label: "DOF focus range", type: "slider", min: 0, max: 1, step: 0.01, value: dofFocusRange, onChange: (v) => { dofFocusRange = v as number; } },
    { key: "dofB", label: "DOF max blur", type: "slider", min: 1, max: 20, step: 0.5, value: dofMaxBlur, onChange: (v) => { dofMaxBlur = v as number; } },
    { key: "mb", label: "Motion Blur", type: "checkbox", value: motionBlurEnabled, onChange: (v) => { motionBlurEnabled = v as boolean; } },
    { key: "mbI", label: "MB intensity", type: "slider", min: 0, max: 3, step: 0.05, value: motionBlurIntensity, onChange: (v) => { motionBlurIntensity = v as number; } },
    { key: "mbS", label: "MB max samples", type: "slider", min: 4, max: 32, step: 1, value: motionBlurSamples, onChange: (v) => { motionBlurSamples = v as number; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
