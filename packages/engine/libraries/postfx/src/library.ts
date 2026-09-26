// ============================================================================
// PostfxLib — declarative engine library descriptor for the PostProcessStack
//
// Games declare `libraries: [PostfxLib]` (or with config override) in their
// GameModule. The host creates a PostProcessStack (renderer-side) and exposes
// it via the PostProcessStackTok typed token.
//
// Games that need full control can still import PostProcessStack directly
// (escape hatch) — this descriptor is a convenience for declarative wiring.
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/engine";
import { PostProcessStack, type EffectId } from "./post-process-stack";

// ── Config ──

export interface PostfxLibConfig {
  /** Effects to enable on startup. Default: none. */
  enabled?: EffectId[];
  /** Depth format for the stack's offscreen depth target. Default: "depth32float". */
  depthFormat?: GPUTextureFormat;
  // ── Per-effect initial parameters (optional) ──
  /** Pixel size for the pixelation effect. Default: 6. */
  pixelSize?: number;
  /** Depth edge strength for pixelation (0–1). Default: 0.4. */
  depthEdgeStrength?: number;
  /** Blur radius for gaussian blur. Default: 2.0. */
  gaussianBlurRadius?: number;
  /** DOF focus distance (0–1). Default: 0.5. */
  dofFocusDist?: number;
  /** DOF focus range (0–1). Default: 0.3. */
  dofFocusRange?: number;
  /** DOF max blur radius. Default: 8. */
  dofMaxBlur?: number;
  /** DOF bokeh shape: 0=circle, 1=hexagon, 2=octagon. Default: 0. */
  dofBokehShape?: number;
  /** DOF kernel sample count (4–48). Default: 32. */
  dofSampleCount?: number;
  /** DOF blur only near field. Default: false. */
  dofNearOnly?: boolean;
  /** DOF blur only far field. Default: false. */
  dofFarOnly?: boolean;
  /** DOF blade rotation (radians). Default: 0. */
  dofBladeRotation?: number;
  /** Bloom threshold (0–2). Default: 0.8. */
  bloomThreshold?: number;
  /** Bloom strength (0–3). Default: 1.0. */
  bloomStrength?: number;
  /** Bloom MIP count for pyramid (1–6). Default: 5. */
  bloomMipCount?: number;
  /** Bloom tint (RGB). Default: [1,1,1]. */
  bloomTint?: [number, number, number];
  /** Bloom soft knee for bright pass (0–1). Default: 0.7. */
  bloomSoftKnee?: number;
  /** Bloom per-MIP upsample weights. Default: [0,0,0.4,0.6,0.8,1.0]. */
  bloomMipWeights?: number[];
  /** Afterimage damping (0–0.99). Default: 0.96. */
  afterimageDamp?: number;
  /** ASCII cell size in pixels. Default: 8. */
  asciiCellSize?: number;
  /** Whether ASCII uses color. Default: false. */
  asciiUseColor?: boolean;
  /** Tonemap exposure. Default: 1.0. */
  exposure?: number;
  /** Tonemap gamma. Default: 2.2. */
  gamma?: number;
  // ── SSAO (GTAO) ──
  /** SSAO slice directions (1–8). Default: 4. */
  ssaoDirections?: number;
  /** SSAO samples per slice (2–16). Default: 8. */
  ssaoSlices?: number;
  /** SSAO radius. Default: 0.5. */
  ssaoRadius?: number;
  /** SSAO bias. Default: 0.025. */
  ssaoBias?: number;
  /** SSAO contrast power. Default: 1.5. */
  ssaoPower?: number;
  /** SSAO thickness. Default: 0.1. */
  ssaoThickness?: number;
  // ── SSR ──
  /** SSR max ray-march steps. Default: 64. */
  ssrMaxSteps?: number;
  /** SSR binary refinement steps. Default: 10. */
  ssrBinarySteps?: number;
  /** SSR thickness. Default: 0.05. */
  ssrThickness?: number;
  /** SSR stride. Default: 1.0. */
  ssrStride?: number;
  // ── TAA ──
  /** TAA blend factor (0–1). Default: 0.1. */
  taaBlendFactor?: number;
  /** TAA variance clamping (reduces ghosting). Default: false. */
  taaVarianceClamp?: boolean;
  // ── New effects ──
  /** White balance temperature (-1 cool to 1 warm). Default: 0. */
  whiteBalanceTemperature?: number;
  /** White balance tint (-1 green to 1 magenta). Default: 0. */
  whiteBalanceTint?: number;
  /** Channel mixer weights [rR,rG,rB, gR,gG,gB, bR,bG,bB]. Default: identity. */
  channelMixerWeights?: [number, number, number, number, number, number, number, number, number];
  /** Channel mixer monochrome output. Default: false. */
  channelMixerMonochrome?: boolean;
  /** Split-tone shadow tint [R,G,B]. Default: [0,0,0]. */
  splitToneShadow?: [number, number, number];
  /** Split-tone highlight tint [R,G,B]. Default: [0,0,0]. */
  splitToneHighlight?: [number, number, number];
  /** Split-tone balance (-1 more shadows to 1 more highlights). Default: 0. */
  splitToneBalance?: number;
  /** Chromatic aberration intensity (0–1). Default: 0.5. */
  chromaticAberrationIntensity?: number;
  /** Chromatic aberration radial falloff start (0–1). Default: 0. */
  chromaticAberrationStart?: number;
  /** Chromatic aberration radial falloff end (0–1). Default: 1. */
  chromaticAberrationEnd?: number;
  /** Chromatic aberration lens center X (0–1). Default: 0.5. */
  chromaticAberrationCenterX?: number;
  /** Chromatic aberration lens center Y (0–1). Default: 0.5. */
  chromaticAberrationCenterY?: number;
  /** Lens distortion intensity (-1 pincushion to 1 barrel). Default: 0. */
  lensDistortionIntensity?: number;
  /** Lens distortion scale (zoom compensation). Default: 1.0. */
  lensDistortionScale?: number;
  /** Lens distortion chromatic split (0–1). Default: 0. */
  lensDistortionChromaSplit?: number;
  /** Halftone cell size in pixels. Default: 8. */
  halftoneCellSize?: number;
  /** Halftone dot scale multiplier (0–2). Default: 1.0. */
  halftoneDotScale?: number;
  /** Halftone screen angle in radians. Default: 0. */
  halftoneAngle?: number;
  /** Halftone monochrome dots. Default: true. */
  halftoneMonochrome?: boolean;
  /** Dithering mode: 0=off, 1=Bayer, 2=blue-noise. Default: 1. */
  ditheringMode?: number;
  /** Dithering strength (0–1). Default: 0.5. */
  ditheringStrength?: number;
  /** Dithering quantization levels (0 = no quantization). Default: 0. */
  ditheringLevels?: number;
  /** Watercolor edge strength (0–2). Default: 1.0. */
  watercolorEdgeStrength?: number;
  /** Watercolor paper texture scale (1–10). Default: 2.0. */
  watercolorPaperScale?: number;
  /** Watercolor blend amount (0–1). Default: 0.7. */
  watercolorBlend?: number;
}

// ── Typed token (DI) ──

/** Token for the renderer-side PostProcessStack. Inject in renderer passes/modules. */
export const PostProcessStackTok = resourceToken<PostProcessStack>("postfx:stack");

// ── Descriptor ──

export const PostfxLib: EngineLibrary<PostfxLibConfig> = {
  name: "postfx",
  version: "2.0.0",

  provides: [PostProcessStackTok],

  // Renderer-side only — no sim system.

  renderer: {
    init(config, ctx) {
      const stack = new PostProcessStack(ctx.device, ctx.format, {
        depthFormat: config.depthFormat ?? "depth32float",
      });
      stack.init();

      // Enable requested effects
      if (config.enabled) {
        config.enabled.forEach((id) => {
          stack.setEnabled(id, true);
        });
      }

      // Apply per-effect parameters
      if (config.pixelSize !== undefined) stack.setPixelationPixelSize(config.pixelSize);
      if (config.depthEdgeStrength !== undefined) stack.setPixelationDepthEdgeStrength(config.depthEdgeStrength);
      if (config.gaussianBlurRadius !== undefined) stack.setGaussianBlurRadius(config.gaussianBlurRadius);
      if (config.dofFocusDist !== undefined) stack.setDOFFocusDist(config.dofFocusDist);
      if (config.dofFocusRange !== undefined) stack.setDOFFocusRange(config.dofFocusRange);
      if (config.dofMaxBlur !== undefined) stack.setDOFMaxBlur(config.dofMaxBlur);
      if (config.dofBokehShape !== undefined) stack.setDOFBokehShape(config.dofBokehShape);
      if (config.dofSampleCount !== undefined) stack.setDOFSampleCount(config.dofSampleCount);
      if (config.dofNearOnly !== undefined) stack.setDOFNearOnly(config.dofNearOnly);
      if (config.dofFarOnly !== undefined) stack.setDOFFarOnly(config.dofFarOnly);
      if (config.dofBladeRotation !== undefined) stack.setDOFBladeRotation(config.dofBladeRotation);
      if (config.bloomThreshold !== undefined) stack.setBloomThreshold(config.bloomThreshold);
      if (config.bloomStrength !== undefined) stack.setBloomStrength(config.bloomStrength);
      if (config.bloomMipCount !== undefined) stack.setBloomMipCount(config.bloomMipCount);
      if (config.bloomTint !== undefined) stack.setBloomTint(config.bloomTint[0], config.bloomTint[1], config.bloomTint[2]);
      if (config.bloomSoftKnee !== undefined) stack.setBloomSoftKnee(config.bloomSoftKnee);
      if (config.bloomMipWeights !== undefined) stack.setBloomMipWeights(config.bloomMipWeights);
      if (config.ssaoDirections !== undefined) stack.setSSAODirections(config.ssaoDirections);
      if (config.ssaoSlices !== undefined) stack.setSSAOSlices(config.ssaoSlices);
      if (config.ssaoRadius !== undefined) stack.setSSAORadius(config.ssaoRadius);
      if (config.ssaoBias !== undefined) stack.setSSAOBias(config.ssaoBias);
      if (config.ssaoPower !== undefined) stack.setSSAOPower(config.ssaoPower);
      if (config.ssaoThickness !== undefined) stack.setSSAOThickness(config.ssaoThickness);
      if (config.ssrMaxSteps !== undefined) stack.setSSRMaxSteps(config.ssrMaxSteps);
      if (config.ssrBinarySteps !== undefined) stack.setSSRBinarySteps(config.ssrBinarySteps);
      if (config.ssrThickness !== undefined) stack.setSSRThickness(config.ssrThickness);
      if (config.ssrStride !== undefined) stack.setSSRStride(config.ssrStride);
      if (config.taaBlendFactor !== undefined) stack.setTAABlendFactor(config.taaBlendFactor);
      if (config.taaVarianceClamp !== undefined) stack.setTAAVarianceClamp(config.taaVarianceClamp);
      if (config.afterimageDamp !== undefined) stack.setAfterimageDamp(config.afterimageDamp);
      if (config.asciiCellSize !== undefined) stack.setASCIICellSize(config.asciiCellSize);
      if (config.asciiUseColor !== undefined) stack.setASCIIUseColor(config.asciiUseColor);
      if (config.exposure !== undefined) stack.setExposure(config.exposure);
      if (config.gamma !== undefined) stack.setGamma(config.gamma);
      // New effects
      if (config.whiteBalanceTemperature !== undefined || config.whiteBalanceTint !== undefined) {
        stack.setWhiteBalance(config.whiteBalanceTemperature ?? 0, config.whiteBalanceTint ?? 0);
      }
      if (config.channelMixerWeights !== undefined) {
        const w = config.channelMixerWeights;
        stack.setChannelMixer(w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8]);
      }
      if (config.channelMixerMonochrome !== undefined) stack.setChannelMixerMonochrome(config.channelMixerMonochrome);
      if (config.splitToneShadow !== undefined || config.splitToneHighlight !== undefined || config.splitToneBalance !== undefined) {
        const s = config.splitToneShadow ?? [0, 0, 0];
        const h = config.splitToneHighlight ?? [0, 0, 0];
        stack.setSplitTone(s[0], s[1], s[2], h[0], h[1], h[2], config.splitToneBalance ?? 0);
      }
      if (config.chromaticAberrationIntensity !== undefined || config.chromaticAberrationStart !== undefined || config.chromaticAberrationEnd !== undefined) {
        stack.setChromaticAberration(
          config.chromaticAberrationIntensity ?? 0.5,
          config.chromaticAberrationStart ?? 0,
          config.chromaticAberrationEnd ?? 1,
        );
      }
      if (config.chromaticAberrationCenterX !== undefined || config.chromaticAberrationCenterY !== undefined) {
        stack.setChromaticAberrationCenter(config.chromaticAberrationCenterX ?? 0.5, config.chromaticAberrationCenterY ?? 0.5);
      }
      if (config.lensDistortionIntensity !== undefined || config.lensDistortionScale !== undefined || config.lensDistortionChromaSplit !== undefined) {
        stack.setLensDistortion(
          config.lensDistortionIntensity ?? 0,
          config.lensDistortionScale ?? 1.0,
          config.lensDistortionChromaSplit ?? 0,
        );
      }
      if (config.halftoneCellSize !== undefined || config.halftoneDotScale !== undefined || config.halftoneAngle !== undefined || config.halftoneMonochrome !== undefined) {
        stack.setHalftone(
          config.halftoneCellSize ?? 8,
          config.halftoneDotScale ?? 1.0,
          config.halftoneAngle ?? 0,
          config.halftoneMonochrome ?? true,
        );
      }
      if (config.ditheringMode !== undefined || config.ditheringStrength !== undefined || config.ditheringLevels !== undefined) {
        stack.setDithering(
          config.ditheringMode ?? 1,
          config.ditheringStrength ?? 0.5,
          config.ditheringLevels ?? 0,
        );
      }
      if (config.watercolorEdgeStrength !== undefined || config.watercolorPaperScale !== undefined || config.watercolorBlend !== undefined) {
        stack.setWatercolor(
          config.watercolorEdgeStrength ?? 1.0,
          config.watercolorPaperScale ?? 2.0,
          config.watercolorBlend ?? 0.7,
        );
      }

      ctx.provide(PostProcessStackTok, stack);
      return stack;
    },
    dispose(instance) {
      (instance as PostProcessStack).destroy();
    },
  },

  defaultConfig: {
    enabled: [],
    depthFormat: "depth32float",
    pixelSize: 6,
    depthEdgeStrength: 0.4,
    gaussianBlurRadius: 2.0,
    dofFocusDist: 0.5,
    dofFocusRange: 0.3,
    dofMaxBlur: 8,
    dofBokehShape: 0,
    dofSampleCount: 32,
    dofNearOnly: false,
    dofFarOnly: false,
    dofBladeRotation: 0,
    bloomThreshold: 0.8,
    bloomStrength: 1.0,
    bloomMipCount: 5,
    bloomTint: [1.0, 1.0, 1.0],
    bloomSoftKnee: 0.7,
    bloomMipWeights: [0.0, 0.0, 0.4, 0.6, 0.8, 1.0],
    ssaoDirections: 4,
    ssaoSlices: 8,
    ssaoRadius: 0.5,
    ssaoBias: 0.025,
    ssaoPower: 1.5,
    ssaoThickness: 0.1,
    ssrMaxSteps: 64,
    ssrBinarySteps: 10,
    ssrThickness: 0.05,
    ssrStride: 1.0,
    taaBlendFactor: 0.1,
    taaVarianceClamp: false,
    afterimageDamp: 0.96,
    asciiCellSize: 8,
    asciiUseColor: false,
    exposure: 1.0,
    gamma: 2.2,
    // New effects
    whiteBalanceTemperature: 0,
    whiteBalanceTint: 0,
    channelMixerWeights: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    channelMixerMonochrome: false,
    splitToneShadow: [0, 0, 0],
    splitToneHighlight: [0, 0, 0],
    splitToneBalance: 0,
    chromaticAberrationIntensity: 0.5,
    chromaticAberrationStart: 0,
    chromaticAberrationEnd: 1,
    chromaticAberrationCenterX: 0.5,
    chromaticAberrationCenterY: 0.5,
    lensDistortionIntensity: 0,
    lensDistortionScale: 1.0,
    lensDistortionChromaSplit: 0,
    halftoneCellSize: 8,
    halftoneDotScale: 1.0,
    halftoneAngle: 0,
    halftoneMonochrome: true,
    ditheringMode: 1,
    ditheringStrength: 0.5,
    ditheringLevels: 0,
    watercolorEdgeStrength: 1.0,
    watercolorPaperScale: 2.0,
    watercolorBlend: 0.7,
  },
};
