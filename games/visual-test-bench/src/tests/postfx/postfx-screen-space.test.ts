// PostFX: Screen-Space — SSAO + SSR
import type { EffectId } from "@downdraft/library-postfx";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let ssaoEnabled = true;
let ssrEnabled = false;
let ssaoRadius = 0.5;
let ssaoBias = 0.025;
let ssaoKernel = 32;
let ssaoDirections = 4;
let ssaoSlices = 8;
let ssaoPower = 1.5;
let ssrMaxSteps = 64;
let ssrThickness = 0.05;
let ssrFadeEnd = 50;
let ssrBinarySteps = 10;
let ssrStride = 1.0;
let rotationSpeed = 0.5;

const EFFECTS: EffectId[] = ["ssao", "ssr"];

registerTest({
  id: "postfx-ss",
  name: "PostFX: Screen-Space",
  category: "PostFX",
  description: "SSAO (screen-space ambient occlusion with blur) and SSR (screen-space reflections via ray marching). Requires normals MRT.",
  requiresWebGPU: true,
  createRenderer: (canvas) => {
    const r = new PostfxTestRenderer(canvas, {
      effects: EFFECTS,
      needsNormals: () => ssaoEnabled || ssrEnabled,
      needsVelocity: () => false,
      needsMask: () => false,
      useSelection: false,
      syncState: (stack) => {
        stack.setEnabled("ssao", ssaoEnabled);
        stack.setEnabled("ssr", ssrEnabled);
        stack.setSSAORadius(ssaoRadius);
        stack.setSSAOBias(ssaoBias);
        stack.setSSAOKernelSize(ssaoKernel);
        stack.setSSAODirections(ssaoDirections);
        stack.setSSAOSlices(ssaoSlices);
        stack.setSSAOPower(ssaoPower);
        stack.setSSRMaxSteps(ssrMaxSteps);
        stack.setSSRThickness(ssrThickness);
        stack.setSSRFadeEnd(ssrFadeEnd);
        stack.setSSRBinarySteps(ssrBinarySteps);
        stack.setSSRStride(ssrStride);
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => ssaoEnabled || ssrEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "ssao", label: "SSAO", type: "checkbox", value: ssaoEnabled, onChange: (v) => { ssaoEnabled = v as boolean; } },
    { key: "ssaoR", label: "SSAO radius", type: "slider", min: 0.1, max: 2, step: 0.05, value: ssaoRadius, onChange: (v) => { ssaoRadius = v as number; } },
    { key: "ssaoB", label: "SSAO bias", type: "slider", min: 0, max: 0.2, step: 0.005, value: ssaoBias, onChange: (v) => { ssaoBias = v as number; } },
    { key: "ssaoK", label: "SSAO kernel size", type: "slider", min: 8, max: 64, step: 1, value: ssaoKernel, onChange: (v) => { ssaoKernel = v as number; } },
    { key: "ssaoD", label: "SSAO directions", type: "slider", min: 1, max: 8, step: 1, value: ssaoDirections, onChange: (v) => { ssaoDirections = v as number; } },
    { key: "ssaoSl", label: "SSAO slices", type: "slider", min: 2, max: 16, step: 1, value: ssaoSlices, onChange: (v) => { ssaoSlices = v as number; } },
    { key: "ssaoP", label: "SSAO power", type: "slider", min: 0.5, max: 3, step: 0.1, value: ssaoPower, onChange: (v) => { ssaoPower = v as number; } },
    { key: "ssr", label: "SSR", type: "checkbox", value: ssrEnabled, onChange: (v) => { ssrEnabled = v as boolean; } },
    { key: "ssrS", label: "SSR max steps", type: "slider", min: 16, max: 128, step: 1, value: ssrMaxSteps, onChange: (v) => { ssrMaxSteps = v as number; } },
    { key: "ssrT", label: "SSR thickness", type: "slider", min: 0.01, max: 0.5, step: 0.01, value: ssrThickness, onChange: (v) => { ssrThickness = v as number; } },
    { key: "ssrF", label: "SSR fade end", type: "slider", min: 10, max: 200, step: 5, value: ssrFadeEnd, onChange: (v) => { ssrFadeEnd = v as number; } },
    { key: "ssrB", label: "SSR binary steps", type: "slider", min: 1, max: 16, step: 1, value: ssrBinarySteps, onChange: (v) => { ssrBinarySteps = v as number; } },
    { key: "ssrSt", label: "SSR stride", type: "slider", min: 0.5, max: 4, step: 0.1, value: ssrStride, onChange: (v) => { ssrStride = v as number; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
