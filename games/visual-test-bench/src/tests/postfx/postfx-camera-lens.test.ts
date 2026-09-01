// PostFX: Camera & Lens — Chromatic Aberration + Lens Distortion (+ DOF bokeh)
import type { EffectId } from "@downdraft/library-postfx";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let chromaticAberrationEnabled = true;
let lensDistortionEnabled = false;
let dofEnabled = false;
let caIntensity = 0.5;
let caStart = 0.0;
let caEnd = 1.0;
let ldIntensity = 0.2;
let ldScale = 1.1;
let ldChromaSplit = 0.3;
let dofFocusDist = 0.5;
let dofFocusRange = 0.3;
let dofMaxBlur = 8;
let dofBokehShape = 0;  // 0=circle, 1=hexagon, 2=octagon
let dofSampleCount = 32;
let rotationSpeed = 0.5;

const EFFECTS: EffectId[] = ["tonemap", "chromatic-aberration", "lens-distortion", "dof"];

registerTest({
  id: "postfx-camera-lens",
  name: "PostFX: Camera & Lens",
  category: "PostFX",
  description: "Chromatic aberration (radial RGB shift with falloff), lens distortion (barrel/pincushion + chromatic split), and upgraded DOF (circle-of-confusion + bokeh-shaped disk sampling with circle/hexagon/octagon apertures).",
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
        stack.setEnabled("chromatic-aberration", chromaticAberrationEnabled);
        stack.setEnabled("lens-distortion", lensDistortionEnabled);
        stack.setEnabled("dof", dofEnabled);
        stack.setChromaticAberration(caIntensity, caStart, caEnd);
        stack.setLensDistortion(ldIntensity, ldScale, ldChromaSplit);
        stack.setDOFFocusDist(dofFocusDist);
        stack.setDOFFocusRange(dofFocusRange);
        stack.setDOFMaxBlur(dofMaxBlur);
        stack.setDOFBokehShape(dofBokehShape);
        stack.setDOFSampleCount(dofSampleCount);
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => chromaticAberrationEnabled || lensDistortionEnabled || dofEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "ca", label: "Chromatic Aberration", type: "checkbox", value: chromaticAberrationEnabled, onChange: (v) => { chromaticAberrationEnabled = v as boolean; } },
    { key: "caI", label: "CA Intensity", type: "slider", min: 0, max: 2, step: 0.05, value: caIntensity, onChange: (v) => { caIntensity = v as number; } },
    { key: "caS", label: "CA Start", type: "slider", min: 0, max: 1, step: 0.05, value: caStart, onChange: (v) => { caStart = v as number; } },
    { key: "caE", label: "CA End", type: "slider", min: 0, max: 1, step: 0.05, value: caEnd, onChange: (v) => { caEnd = v as number; } },
    { key: "ld", label: "Lens Distortion", type: "checkbox", value: lensDistortionEnabled, onChange: (v) => { lensDistortionEnabled = v as boolean; } },
    { key: "ldI", label: "LD Intensity", type: "slider", min: -1, max: 1, step: 0.05, value: ldIntensity, onChange: (v) => { ldIntensity = v as number; } },
    { key: "ldS", label: "LD Scale", type: "slider", min: 0.5, max: 2, step: 0.05, value: ldScale, onChange: (v) => { ldScale = v as number; } },
    { key: "ldC", label: "LD Chroma Split", type: "slider", min: 0, max: 1, step: 0.05, value: ldChromaSplit, onChange: (v) => { ldChromaSplit = v as number; } },
    { key: "dof", label: "DOF", type: "checkbox", value: dofEnabled, onChange: (v) => { dofEnabled = v as boolean; } },
    { key: "dFD", label: "DOF Focus Dist", type: "slider", min: 0, max: 1, step: 0.05, value: dofFocusDist, onChange: (v) => { dofFocusDist = v as number; } },
    { key: "dFR", label: "DOF Focus Range", type: "slider", min: 0, max: 1, step: 0.05, value: dofFocusRange, onChange: (v) => { dofFocusRange = v as number; } },
    { key: "dMB", label: "DOF Max Blur", type: "slider", min: 1, max: 16, step: 0.5, value: dofMaxBlur, onChange: (v) => { dofMaxBlur = v as number; } },
    { key: "dBS", label: "DOF Bokeh Shape", type: "slider", min: 0, max: 2, step: 1, value: dofBokehShape, onChange: (v) => { dofBokehShape = v as number; } },
    { key: "dSC", label: "DOF Samples", type: "slider", min: 4, max: 48, step: 4, value: dofSampleCount, onChange: (v) => { dofSampleCount = v as number; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
