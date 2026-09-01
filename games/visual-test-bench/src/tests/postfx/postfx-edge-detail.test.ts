// PostFX: Edge & Detail — Sobel + Edges + Sharpen
import type { EffectId } from "@downdraft/core";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let sobelEnabled = true;
let edgesEnabled = false;
let sharpenEnabled = false;
let edgesThreshold = 0.4;
let edgesOpacity = 1.0;
let sharpenSharpness = 0.5;
let rotationSpeed = 0.5;

const EFFECTS: EffectId[] = ["sobel", "edges", "sharpen"];

registerTest({
  id: "postfx-edge",
  name: "PostFX: Edge & Detail",
  category: "PostFX",
  description: "Sobel (color-based edge detection), Edges (depth + normal edge detection with configurable color), and Sharpen (unsharp mask). Edges requires normals MRT.",
  requiresWebGPU: true,
  createRenderer: (canvas) => {
    const r = new PostfxTestRenderer(canvas, {
      effects: EFFECTS,
      needsNormals: () => edgesEnabled,
      needsVelocity: () => false,
      needsMask: () => false,
      useSelection: false,
      syncState: (stack) => {
        stack.setEnabled("sobel", sobelEnabled);
        stack.setEnabled("edges", edgesEnabled);
        stack.setEnabled("sharpen", sharpenEnabled);
        stack.setEdgesThreshold(edgesThreshold);
        stack.setEdgesOpacity(edgesOpacity);
        stack.setSharpenSharpness(sharpenSharpness);
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => sobelEnabled || edgesEnabled || sharpenEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "sob", label: "Sobel", type: "checkbox", value: sobelEnabled, onChange: (v) => { sobelEnabled = v as boolean; } },
    { key: "edg", label: "Edges (depth+normal)", type: "checkbox", value: edgesEnabled, onChange: (v) => { edgesEnabled = v as boolean; } },
    { key: "edgT", label: "Edges threshold", type: "slider", min: 0, max: 1, step: 0.05, value: edgesThreshold, onChange: (v) => { edgesThreshold = v as number; } },
    { key: "edgO", label: "Edges opacity", type: "slider", min: 0, max: 1, step: 0.05, value: edgesOpacity, onChange: (v) => { edgesOpacity = v as number; } },
    { key: "shp", label: "Sharpen", type: "checkbox", value: sharpenEnabled, onChange: (v) => { sharpenEnabled = v as boolean; } },
    { key: "shpS", label: "Sharpen strength", type: "slider", min: 0, max: 2, step: 0.05, value: sharpenSharpness, onChange: (v) => { sharpenSharpness = v as number; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
