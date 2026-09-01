// PostFX: Color Grading — LUT + White Balance + Channel Mixer + Split-Tone
import type { EffectId } from "@downdraft/library-postfx";
import { registerTest, type TestControl } from "../../test-registry";
import { PostfxTestRenderer } from "../helpers/postfx-test-renderer";

let lutEnabled = true;
let whiteBalanceEnabled = false;
let channelMixerEnabled = false;
let splitToneEnabled = false;
let wbTemp = 0.3;
let wbTint = 0.0;
let cmMonochrome = false;
let stBalance = 0.0;
let rotationSpeed = 0.5;

const EFFECTS: EffectId[] = ["tonemap", "lut", "white-balance", "channel-mixer", "split-tone"];

// Generate a neutral 16³ LUT (identity passthrough) as a fallback.
// A real game would load a .cube file or a pre-baked grading LUT.
function generateNeutralLUT(size: number): Uint8Array {
  const data = new Uint8Array(size * size * size * 4);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const idx = (b * size * size + g * size + r) * 4;
        // Identity: output = input, mapped to [0,255]
        data[idx] = Math.round((r / (size - 1)) * 255);
        data[idx + 1] = Math.round((g / (size - 1)) * 255);
        data[idx + 2] = Math.round((b / (size - 1)) * 255);
        data[idx + 3] = 255;
      }
    }
  }
  return data;
}

// Generate a teal-orange cinematic LUT (shadows → teal, highlights → warm orange)
function generateTealOrangeLUT(size: number): Uint8Array {
  const data = new Uint8Array(size * size * size * 4);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const idx = (b * size * size + g * size + r) * 4;
        const rn = r / (size - 1);
        const gn = g / (size - 1);
        const bn = b / (size - 1);
        // Shadows: push toward teal (reduce R, boost B)
        // Highlights: push toward orange (boost R, reduce B)
        const shadowFactor = 1.0 - (rn * 0.299 + gn * 0.587 + bn * 0.114);
        const highlightFactor = rn * 0.299 + gn * 0.587 + bn * 0.114;
        data[idx] = Math.round(clamp255((rn - shadowFactor * 0.15 + highlightFactor * 0.1) * 255));
        data[idx + 1] = Math.round(clamp255(gn * 255));
        data[idx + 2] = Math.round(clamp255((bn + shadowFactor * 0.15 - highlightFactor * 0.1) * 255));
        data[idx + 3] = 255;
      }
    }
  }
  return data;
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, v));
}

let useTealOrange = true;
const LUT_SIZE = 16;

registerTest({
  id: "postfx-color-grading",
  name: "PostFX: Color Grading",
  category: "PostFX",
  description: "3D LUT color grading (teal-orange cinematic / neutral), white balance (temperature + tint), channel mixer (per-channel remap + monochrome), and split-tone (shadow/highlight tinting). LDR post-tonemap pipeline.",
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
        stack.setEnabled("lut", lutEnabled);
        stack.setEnabled("white-balance", whiteBalanceEnabled);
        stack.setEnabled("channel-mixer", channelMixerEnabled);
        stack.setEnabled("split-tone", splitToneEnabled);
        // Load LUT (teal-orange or neutral)
        const lutData = useTealOrange ? generateTealOrangeLUT(LUT_SIZE) : generateNeutralLUT(LUT_SIZE);
        stack.setLUT(lutData, LUT_SIZE);
        stack.setLUTEnabled(lutEnabled);
        stack.setWhiteBalance(wbTemp, wbTint);
        stack.setChannelMixerMonochrome(cmMonochrome);
        // Split-tone: teal shadows, orange highlights
        stack.setSplitTone(-0.15, 0.0, 0.1, 0.15, 0.0, -0.1, stBalance);
        r.setRotationSpeed(rotationSpeed);
      },
      anyEnabled: () => lutEnabled || whiteBalanceEnabled || channelMixerEnabled || splitToneEnabled,
    });
    return r;
  },
  getControls: (): TestControl[] => [
    { key: "lut", label: "LUT", type: "checkbox", value: lutEnabled, onChange: (v) => { lutEnabled = v as boolean; } },
    { key: "lutType", label: "Teal-Orange LUT", type: "checkbox", value: useTealOrange, onChange: (v) => { useTealOrange = v as boolean; } },
    { key: "wb", label: "White Balance", type: "checkbox", value: whiteBalanceEnabled, onChange: (v) => { whiteBalanceEnabled = v as boolean; } },
    { key: "wbT", label: "WB Temperature", type: "slider", min: -1, max: 1, step: 0.05, value: wbTemp, onChange: (v) => { wbTemp = v as number; } },
    { key: "wbTi", label: "WB Tint", type: "slider", min: -1, max: 1, step: 0.05, value: wbTint, onChange: (v) => { wbTint = v as number; } },
    { key: "cm", label: "Channel Mixer", type: "checkbox", value: channelMixerEnabled, onChange: (v) => { channelMixerEnabled = v as boolean; } },
    { key: "cmM", label: "CM Monochrome", type: "checkbox", value: cmMonochrome, onChange: (v) => { cmMonochrome = v as boolean; } },
    { key: "st", label: "Split-Tone", type: "checkbox", value: splitToneEnabled, onChange: (v) => { splitToneEnabled = v as boolean; } },
    { key: "stB", label: "ST Balance", type: "slider", min: -1, max: 1, step: 0.05, value: stBalance, onChange: (v) => { stBalance = v as number; } },
    { key: "rot", label: "Rotation speed", type: "slider", min: 0, max: 3, step: 0.1, value: rotationSpeed, onChange: (v) => { rotationSpeed = v as number; } },
  ],
});
