// ============================================================================
// PostProcess Stack — unified chainable WebGPU postprocessing
//
// All 21 effects: taa, ssao, ssr, dof, motion-blur, bloom, bloom-soft,
// tonemap, fxaa, sharpen, grain, sobel, edges, lens-flare, pixelation,
// gaussian-blur, afterimage, outline, highlight, glow, ascii.
//
// HDR section (taa → bloom-soft) uses rgba16float intermediates.
// tonemap is the HDR→LDR bridge.
// LDR section (fxaa → ascii) also uses rgba16float intermediates.
// A final blit copies the result to the canvas-format swapchain view.
// ============================================================================

import { createValidatedShaderModule } from "@downdraft/core";

export interface ViewportRect { x: number; y: number; w: number; h: number; }
export interface PostProcessStackOptions {
  depthFormat?: GPUTextureFormat;
}

import AFTERIMAGE_FS from "./shaders/post-process/afterimage.wgsl?raw";
import ASCII_FS from "./shaders/post-process/ascii.wgsl?raw";
import BLIT_FS from "./shaders/post-process/blit.wgsl?raw";
import BLOOM_BLUR_FS from "./shaders/post-process/bloom-blur.wgsl?raw";
import BLOOM_BRIGHT_FS from "./shaders/post-process/bloom-bright.wgsl?raw";
import BLOOM_COMPOSITE_FS from "./shaders/post-process/bloom-composite.wgsl?raw";
import BLOOM_DOWNSAMPLE_FS from "./shaders/post-process/bloom-downsample.wgsl?raw";
import BLOOM_SOFT_FS from "./shaders/post-process/bloom-soft.wgsl?raw";
import BLOOM_UPSAMPLE_FS from "./shaders/post-process/bloom-upsample.wgsl?raw";
import CHANNEL_MIXER_FS from "./shaders/post-process/channel-mixer.wgsl?raw";
import CHROMATIC_ABERRATION_FS from "./shaders/post-process/chromatic-aberration.wgsl?raw";
import DITHERING_FS from "./shaders/post-process/dithering.wgsl?raw";
import DOF_FS from "./shaders/post-process/dof.wgsl?raw";
import EDGES_FS from "./shaders/post-process/edges.wgsl?raw";
import VS from "./shaders/post-process/fullscreen-vs.wgsl?raw";
import FXAA_FS from "./shaders/post-process/fxaa.wgsl?raw";
import GAUSSIAN_BLUR_FS from "./shaders/post-process/gaussian-blur.wgsl?raw";
import GLOW_BLUR_FS from "./shaders/post-process/glow-blur.wgsl?raw";
import GLOW_COMPOSITE_FS from "./shaders/post-process/glow-composite.wgsl?raw";
import GRAIN_FS from "./shaders/post-process/grain.wgsl?raw";
import HALFTONE_FS from "./shaders/post-process/halftone.wgsl?raw";
import HIGHLIGHT_BLUR_FS from "./shaders/post-process/highlight-blur.wgsl?raw";
import HIGHLIGHT_COMPOSITE_FS from "./shaders/post-process/highlight-composite.wgsl?raw";
import LENS_DISTORTION_FS from "./shaders/post-process/lens-distortion.wgsl?raw";
import LENS_FLARE_FS from "./shaders/post-process/lens-flare.wgsl?raw";
import LUT_FS from "./shaders/post-process/lut.wgsl?raw";
import MOTION_BLUR_FS from "./shaders/post-process/motion-blur.wgsl?raw";
import OCCLUDER_CHUNK from "./shaders/post-process/occluder-chunk.wgsl?raw";
import OUTLINE_FS from "./shaders/post-process/outline.wgsl?raw";
import PIXELATION_FS from "./shaders/post-process/pixelation.wgsl?raw";
import SHARPEN_FS from "./shaders/post-process/sharpen.wgsl?raw";
import SOBEL_FS from "./shaders/post-process/sobel.wgsl?raw";
import SPLIT_TONE_FS from "./shaders/post-process/split-tone.wgsl?raw";
import SSAO_BLUR_FS from "./shaders/post-process/ssao-blur.wgsl?raw";
import SSAO_COMPOSITE_FS from "./shaders/post-process/ssao-composite.wgsl?raw";
import SSAO_FS from "./shaders/post-process/ssao.wgsl?raw";
import SSR_FS from "./shaders/post-process/ssr.wgsl?raw";
import TAA_FS from "./shaders/post-process/taa.wgsl?raw";
import TONEMAP_FS from "./shaders/post-process/tonemap.wgsl?raw";
import WATERCOLOR_FS from "./shaders/post-process/watercolor.wgsl?raw";
import WHITE_BALANCE_FS from "./shaders/post-process/white-balance.wgsl?raw";

// ── Effect IDs ──────────────────────────────────────────────────────────────

export type EffectId =
  | "taa" | "ssao" | "ssr" | "dof" | "motion-blur"
  | "bloom" | "bloom-soft" | "tonemap"
  // Color grading (LDR, post-tonemap)
  | "lut" | "white-balance" | "channel-mixer" | "split-tone"
  // Camera/lens (LDR)
  | "fxaa" | "chromatic-aberration" | "lens-distortion" | "sharpen" | "grain"
  // Stylized (LDR, late chain)
  | "sobel" | "edges" | "lens-flare"
  | "pixelation" | "gaussian-blur" | "afterimage"
  | "halftone" | "dithering" | "watercolor"
  | "outline" | "highlight" | "glow" | "ascii";

const ALL_EFFECTS: EffectId[] = [
  "taa", "ssao", "ssr", "dof", "motion-blur",
  "bloom", "bloom-soft", "tonemap",
  "lut", "white-balance", "channel-mixer", "split-tone",
  "fxaa", "chromatic-aberration", "lens-distortion", "sharpen", "grain",
  "sobel", "edges", "lens-flare",
  "pixelation", "gaussian-blur", "afterimage",
  "halftone", "dithering", "watercolor",
  "outline", "highlight", "glow", "ascii",
];

const CHAIN_ORDER: EffectId[] = [
  // HDR
  "taa", "ssao", "ssr", "dof", "motion-blur",
  "bloom", "bloom-soft", "tonemap",
  // Color grading (LDR, post-tonemap)
  "lut", "white-balance", "channel-mixer", "split-tone",
  // Camera/lens (LDR)
  "fxaa", "chromatic-aberration", "lens-distortion", "sharpen", "grain",
  // Stylized (LDR, late chain)
  "sobel", "edges", "lens-flare",
  "pixelation", "gaussian-blur", "afterimage",
  "halftone", "dithering", "watercolor",
  "outline", "highlight", "glow", "ascii",
];

const EFFECT_NAMES: Record<EffectId, string> = {
  taa: "TAA", ssao: "SSAO", ssr: "SSR", dof: "DOF", "motion-blur": "Motion Blur",
  bloom: "Bloom", "bloom-soft": "Bloom (Soft)", tonemap: "Tonemap",
  lut: "LUT (3D)", "white-balance": "White Balance", "channel-mixer": "Channel Mixer",
  "split-tone": "Split Tone",
  fxaa: "FXAA", "chromatic-aberration": "Chromatic Aberration",
  "lens-distortion": "Lens Distortion", sharpen: "Sharpen", grain: "Grain",
  sobel: "Sobel", edges: "Edges", "lens-flare": "Lens Flare",
  pixelation: "Pixelation", "gaussian-blur": "Gaussian Blur", afterimage: "Afterimage",
  halftone: "Halftone", dithering: "Dithering", watercolor: "Watercolor",
  outline: "Outline", highlight: "Highlight", glow: "Glow", ascii: "ASCII",
};

const HDR_FORMAT: GPUTextureFormat = "rgba16float";

// ── PostProcessStack ────────────────────────────────────────────────────────

export class PostProcessStack {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;

  // Bind group layouts (5 shared layouts)
  private ccLayout!: GPUBindGroupLayout;     // float + float + filtering + uniform
  private cdLayout!: GPUBindGroupLayout;     // float + depth + non-filtering + uniform
  private cvvhLayout!: GPUBindGroupLayout;   // float + float + float + filtering + uniform
  private cvdLayout!: GPUBindGroupLayout;    // float + float + depth + non-filtering + uniform
  private dnfnLayout!: GPUBindGroupLayout;   // depth + float + float + non-filtering + uniform

  private linearSampler!: GPUSampler;
  private nearestSampler!: GPUSampler;

  // Pipelines + uniform buffers (keyed by pipeline name)
  private pipelines: Record<string, GPURenderPipeline> = {};
  private uniforms: Record<string, GPUBuffer> = {};

  // Occlusion culling — shared bind group (group 1) bound on every pass.
  // Contains up to 8 opaque UI panel rects in UV space; shaders discard
  // fragments inside these rects to skip work where the output is invisible.
  private occluderLayout!: GPUBindGroupLayout;
  private occluderUniform!: GPUBuffer;
  private occluderBindGroup!: GPUBindGroup;
  private occluderRects: { x: number; y: number; w: number; h: number }[] = [];
  private occluderKey = "";
  private taaHistoryReset = false;

  // Render targets
  private sceneColor: GPUTexture | null = null;
  private sceneDepth: GPUTexture | null = null;
  private sceneNormals: GPUTexture | null = null;
  private sceneVelocity: GPUTexture | null = null;
  private sceneMask: GPUTexture | null = null;
  private pingPong: [GPUTexture | null, GPUTexture | null] = [null, null];

  // Effect-specific targets
  private afterimageTex: GPUTexture | null = null;
  private taaHistory: GPUTexture | null = null;
  private taaHistory2: GPUTexture | null = null;
  private bloomBright: GPUTexture | null = null;
  private bloomBlurH: GPUTexture | null = null;
  private bloomBlurV: GPUTexture | null = null;
  private bloomMip: GPUTexture[] = [];          // multi-MIP pyramid (downsample cascade)
  private halfResA: GPUTexture | null = null;  // shared by bloom-soft
  private halfResB: GPUTexture | null = null;
  private ssaoA: GPUTexture | null = null;
  private ssaoB: GPUTexture | null = null;
  private blurA: GPUTexture | null = null;     // shared by gaussian-blur, highlight, glow
  private blurB: GPUTexture | null = null;

  // Static textures
  private dummyTex!: GPUTexture;
  private glyphTex: GPUTexture | null = null;
  private noiseTex: GPUTexture | null = null;

  // Bloom-soft result (stored for tonemap to read)
  private bloomSoftResult: GPUTextureView | null = null;

  // Dimensions
  private texW = 0;
  private texH = 0;

  // Enabled state
  private enabled: Record<EffectId, boolean> = Object.fromEntries(
    ALL_EFFECTS.map(e => [e, false])
  ) as Record<EffectId, boolean>;
  private prevEnabled: Record<EffectId, boolean> = { ...this.enabled };

  // Settings
  private grainTime = 0;
  private lightScreenPos: [number, number] = [0.5, 0.5];
  private camProj: Float32Array | null = null;
  private camInvProj: Float32Array | null = null;
  private camView: Float32Array | null = null;

  // DOF
  private dofFocusDist = 0.5;
  private dofFocusRange = 0.3;
  private dofMaxBlur = 8.0;
  private dofBokehShape = 0;       // 0=circle, 1=hexagon, 2=octagon
  private dofSampleCount = 32;
  private dofNearOnly = false;
  private dofFarOnly = false;
  private dofBladeRotation = 0.0;
  // Afterimage
  private afterimageDamp = 0.96;
  // Bloom
  private bloomThreshold = 0.8;
  private bloomStrength = 1.0;
  private bloomMipCount = 5;       // number of downsample levels (full→½→¼→⅛→1/16)
  private bloomTint: [number, number, number] = [1.0, 1.0, 1.0];
  private bloomSoftKnee = 0.7;     // soft threshold knee for bright pass
  // Per-MIP upsample weights (index 0 = largest MIP, last = smallest)
  private bloomMipWeights: number[] = [0.0, 0.0, 0.4, 0.6, 0.8, 1.0];
  // Bloom-soft
  private bloomSoftThreshold = 1.0;
  private bloomSoftSoftThreshold = 0.5;
  private bloomSoftIntensity = 0.3;
  // Tonemap
  private exposure = 1.0;
  private gamma = 2.2;
  private contrast = 1.0;
  private saturation = 1.0;
  private vignette = 0.3;
  // TAA
  private taaBlendFactor = 0.1;
  private taaVarianceClamp = false;
  private taaJitterX = 0;
  private taaJitterY = 0;
  // SSAO (GTAO)
  private ssaoRadius = 0.5;
  private ssaoBias = 0.025;
  private ssaoKernelSize = 32;      // compat alias → maps to ssaoDirections
  private ssaoDirections = 4;       // GTAO slice directions
  private ssaoSlices = 8;           // GTAO samples per slice
  private ssaoPower = 1.5;          // AO contrast power
  private ssaoThickness = 0.1;      // horizon depth thickness
  // SSR (DDA + binary refinement)
  private ssrMaxSteps = 64;
  private ssrThickness = 0.05;
  private ssrMaxDistance = 100.0;
  private ssrFadeStart = 10.0;
  private ssrFadeEnd = 50.0;
  private ssrBinarySteps = 10;
  private ssrStride = 1.0;
  // Motion blur
  private motionBlurIntensity = 1.0;
  private motionBlurMaxSamples = 16;
  // Sharpen
  private sharpenSharpness = 0.5;
  // Grain
  private grainIntensity = 0.15;
  private grainSize = 2.0;
  private grainLuminanceAware = false;
  // Edges
  private edgesThreshold = 0.4;
  private edgesOpacity = 1.0;
  private edgesEdgeColor: [number, number, number] = [1.0, 1.0, 1.0];
  // Lens flare
  private lensFlareIntensity = 0.8;
  private lensFlareThreshold = 0.9;
  private lensFlareGhostCount = 8;
  private lensFlareGhostSpacing = 0.15;
  private lensFlareHaloWidth = 0.2;
  private lensFlareTint: [number, number, number] = [1.0, 0.9, 0.8];
  // Pixelation
  private pixelationPixelSize = 6;
  private pixelationDepthEdgeStrength = 0.4;
  // Gaussian blur
  private gaussianBlurRadius = 2.0;
  // Outline
  private outlineColor: [number, number, number] = [1.0, 0.8, 0.2];
  private outlineWidth = 2.0;
  private outlineOpacity = 1.0;
  // Highlight
  private highlightIntensity = 0.8;
  private highlightInnerOpacity = 0.3;
  private highlightBlurRadius = 3.0;
  // Glow
  private glowIntensity = 1.0;
  private glowBlurRadius = 4.0;
  // ASCII
  private asciiCellSize = 8;
  private asciiUseColor = 1.0;
  // LUT (3D color grading)
  private lutTexture: GPUTexture | null = null;
  private lutView: GPUTextureView | null = null;
  private lutSize = 32;
  private lutEnabled = true;
  private lutLayout!: GPUBindGroupLayout;
  // White balance
  private wbTemperature = 0.0;
  private wbTint = 0.0;
  // Channel mixer
  private cmWeights: [number, number, number, number, number, number, number, number, number] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  private cmMonochrome = false;
  // Split-tone
  private stShadow: [number, number, number] = [0.0, 0.0, 0.0];
  private stHighlight: [number, number, number] = [0.0, 0.0, 0.0];
  private stBalance = 0.0;
  // Chromatic aberration
  private caIntensity = 0.5;
  private caStart = 0.0;
  private caEnd = 1.0;
  private caCenterX = 0.5;
  private caCenterY = 0.5;
  // Lens distortion
  private ldIntensity = 0.0;
  private ldScale = 1.0;
  private ldChromaSplit = 0.0;
  // Halftone
  private htCellSize = 8.0;
  private htDotScale = 1.0;
  private htAngle = 0.0;
  private htMonochrome = true;
  // Dithering
  private dMode = 1;        // 0=off, 1=bayer, 2=bluenoise
  private dStrength = 0.5;
  private dLevels = 0;      // 0 = no quantization
  // Watercolor
  private wcEdgeStrength = 1.0;
  private wcPaperScale = 2.0;
  private wcBlend = 0.7;

  constructor(device: GPUDevice, format: GPUTextureFormat, options?: PostProcessStackOptions) {
    this.device = device;
    this.format = format;
    this.depthFormat = options?.depthFormat ?? "depth32float";
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  init(): void {
    this.linearSampler = this.device.createSampler({
      magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });
    this.nearestSampler = this.device.createSampler({
      magFilter: "nearest", minFilter: "nearest",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });

    // 5 shared bind group layouts
    this.ccLayout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ]});
    this.cdLayout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ]});
    this.cvvhLayout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ]});
    this.cvdLayout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ]});
    this.dnfnLayout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ]});
    // LUT layout: color2D + lut3D + sampler + uniform
    this.lutLayout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ]});

    // Dummy texture (1×1 black)
    this.dummyTex = this.device.createTexture({
      size: [1, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.dummyTex },
      new Uint8Array([0, 0, 0, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1],
    );

    // Occlusion culling bind group (group 1, shared by all postfx pipelines).
    // Layout: single uniform buffer at binding 0, FRAGMENT visibility.
    // Buffer: 16-byte header (count + padding) + 8 × vec4 rects = 144 bytes.
    this.occluderLayout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ]});
    this.occluderUniform = this.device.createBuffer({
      size: 144,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.occluderBindGroup = this.device.createBindGroup({
      layout: this.occluderLayout,
      entries: [{ binding: 0, resource: { buffer: this.occluderUniform } }],
    });
    // Initialize to zero occluders (no occlusion).
    this.device.queue.writeBuffer(this.occluderUniform, 0, new Float32Array(36));

    // Uniform buffers — 48 bytes for simple effects, 256 for matrix effects
    const simpleKeys = [
      "fxaa", "dof", "sobel", "afterimage", "bloom-bright", "bloom-blur", "bloom-composite",
      "bloom-downsample", "bloom-upsample",
      "ascii", "blit", "taa", "motion-blur", "bloom-soft", "tonemap", "sharpen", "grain",
      "edges", "lens-flare", "pixelation", "gaussian-blur", "outline",
      "ssao-blur", "ssao-composite", "highlight-blur", "highlight-composite",
      "glow-blur", "glow-composite",
      // New effects
      "lut", "white-balance", "channel-mixer", "split-tone",
      "chromatic-aberration", "lens-distortion",
      "halftone", "dithering", "watercolor",
    ];
    for (const k of simpleKeys) this.uniforms[k] = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uniforms["ssao"] = this.device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uniforms["ssr"] = this.device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // Pipelines
    const mk = (fs: string, layout: GPUBindGroupLayout, fmt: GPUTextureFormat = HDR_FORMAT) =>
      this.makePipeline(fs, layout, fmt);

    this.pipelines["fxaa"] = mk(FXAA_FS, this.ccLayout);
    this.pipelines["dof"] = mk(DOF_FS, this.cdLayout);
    this.pipelines["sobel"] = mk(SOBEL_FS, this.ccLayout);
    this.pipelines["afterimage"] = mk(AFTERIMAGE_FS, this.ccLayout);
    this.pipelines["bloom-bright"] = mk(BLOOM_BRIGHT_FS, this.ccLayout);
    this.pipelines["bloom-blur"] = mk(BLOOM_BLUR_FS, this.ccLayout);
    this.pipelines["bloom-composite"] = mk(BLOOM_COMPOSITE_FS, this.ccLayout);
    this.pipelines["bloom-downsample"] = mk(BLOOM_DOWNSAMPLE_FS, this.ccLayout);
    this.pipelines["bloom-upsample"] = mk(BLOOM_UPSAMPLE_FS, this.ccLayout);
    this.pipelines["ascii"] = mk(ASCII_FS, this.ccLayout);
    this.pipelines["blit"] = mk(BLIT_FS, this.ccLayout, this.format);
    // HDR blit variant for intermediate passes inside the HDR chain section
    this.pipelines["blit-hdr"] = mk(BLIT_FS, this.ccLayout, HDR_FORMAT);
    this.pipelines["taa"] = mk(TAA_FS, this.cvvhLayout);
    this.pipelines["ssao"] = mk(SSAO_FS, this.dnfnLayout);
    this.pipelines["ssao-blur"] = mk(SSAO_BLUR_FS, this.cdLayout);
    this.pipelines["ssao-composite"] = mk(SSAO_COMPOSITE_FS, this.ccLayout);
    this.pipelines["ssr"] = mk(SSR_FS, this.cvdLayout);
    this.pipelines["motion-blur"] = mk(MOTION_BLUR_FS, this.cvdLayout);
    this.pipelines["bloom-soft"] = mk(BLOOM_SOFT_FS, this.ccLayout);
    this.pipelines["tonemap"] = mk(TONEMAP_FS, this.ccLayout);
    this.pipelines["sharpen"] = mk(SHARPEN_FS, this.ccLayout);
    this.pipelines["grain"] = mk(GRAIN_FS, this.ccLayout);
    this.pipelines["edges"] = mk(EDGES_FS, this.cvdLayout);
    this.pipelines["lens-flare"] = mk(LENS_FLARE_FS, this.cdLayout);
    this.pipelines["pixelation"] = mk(PIXELATION_FS, this.cdLayout);
    this.pipelines["gaussian-blur"] = mk(GAUSSIAN_BLUR_FS, this.ccLayout);
    this.pipelines["outline"] = mk(OUTLINE_FS, this.ccLayout);
    this.pipelines["highlight-blur"] = mk(HIGHLIGHT_BLUR_FS, this.ccLayout);
    this.pipelines["highlight-composite"] = mk(HIGHLIGHT_COMPOSITE_FS, this.cvvhLayout);
    this.pipelines["glow-blur"] = mk(GLOW_BLUR_FS, this.ccLayout);
    this.pipelines["glow-composite"] = mk(GLOW_COMPOSITE_FS, this.ccLayout);
    // New effects
    this.pipelines["lut"] = mk(LUT_FS, this.lutLayout);
    this.pipelines["white-balance"] = mk(WHITE_BALANCE_FS, this.ccLayout);
    this.pipelines["channel-mixer"] = mk(CHANNEL_MIXER_FS, this.ccLayout);
    this.pipelines["split-tone"] = mk(SPLIT_TONE_FS, this.ccLayout);
    this.pipelines["chromatic-aberration"] = mk(CHROMATIC_ABERRATION_FS, this.ccLayout);
    this.pipelines["lens-distortion"] = mk(LENS_DISTORTION_FS, this.ccLayout);
    this.pipelines["halftone"] = mk(HALFTONE_FS, this.ccLayout);
    this.pipelines["dithering"] = mk(DITHERING_FS, this.ccLayout);  // color + noise + sampler + uniform
    this.pipelines["watercolor"] = mk(WATERCOLOR_FS, this.ccLayout);  // color + noise + sampler + uniform

    this.createGlyphAtlas();
    this.createNoiseTexture();
  }

  private makePipeline(fsCode: string, layout: GPUBindGroupLayout, targetFormat: GPUTextureFormat): GPURenderPipeline {
    const shader = createValidatedShaderModule(this.device, { code: VS + "\n" + OCCLUDER_CHUNK + "\n" + fsCode, label: "PostProcessStack" });
    const pl = this.device.createPipelineLayout({ bindGroupLayouts: [layout, this.occluderLayout] });
    return this.device.createRenderPipeline({
      layout: pl,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: targetFormat }] },
      primitive: { topology: "triangle-list" },
    });
  }

  private createGlyphAtlas(): void {
    const chars = " .:-=+*#%@";
    const gw = 16, gh = 16, cols = chars.length;
    const canvas = document.createElement("canvas");
    canvas.width = cols * gw; canvas.height = gh;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "black"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "white"; ctx.font = `bold ${gh - 2}px monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let i = 0; i < chars.length; i++) ctx.fillText(chars[i], i * gw + gw / 2, gh / 2);
    this.glyphTex = this.device.createTexture({
      size: [canvas.width, canvas.height], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: this.glyphTex }, [canvas.width, canvas.height]);
  }

  private createNoiseTexture(): void {
    const size = 4;
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.floor(Math.random() * 255);
      data[i + 1] = Math.floor(Math.random() * 255);
      data[i + 2] = 0; data[i + 3] = 255;
    }
    this.noiseTex = this.device.createTexture({
      size: [size, size], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.noiseTex }, data,
      { bytesPerRow: size * 4 }, [size, size],
    );
  }

  // ── Public API: queries ───────────────────────────────────────────────────

  hasEnabledEffects(): boolean {
    return (Object.values(this.enabled) as boolean[]).some(v => v);
  }

  getEnabledEffects(): string[] {
    return CHAIN_ORDER.filter(id => this.enabled[id]).map(id => EFFECT_NAMES[id]);
  }

  isEnabled(id: EffectId): boolean { return this.enabled[id]; }

  // ── Public API: occlusion culling ──────────────────────────────────────────

  /**
   * Set opaque UI panel rects (in UV space, 0-1, top-left origin) that the
   * postfx shaders should skip. Up to 8 rects; extras are clamped. When the
   * rects change, TAA history is reset for one frame to avoid stale-history
   * artifacts in the previously-occluded region.
   */
  setOccluderRects(rects: { x: number; y: number; w: number; h: number }[]): void {
    const clamped = rects.slice(0, 8);
    const key = clamped.map(r => `${r.x.toFixed(4)},${r.y.toFixed(4)},${r.w.toFixed(4)},${r.h.toFixed(4)}`).join("|");
    if (key !== this.occluderKey) {
      this.occluderKey = key;
      this.taaHistoryReset = true;
    }
    this.occluderRects = clamped;
    // Build uniform data: [count, 0, 0, 0, rect0.xyzw, rect1.xyzw, ...]
    const data = new Float32Array(36);
    data[0] = clamped.length;
    for (let i = 0; i < clamped.length && i < 8; i++) {
      data[4 + i * 4] = clamped[i].x;
      data[4 + i * 4 + 1] = clamped[i].y;
      data[4 + i * 4 + 2] = clamped[i].w;
      data[4 + i * 4 + 3] = clamped[i].h;
    }
    this.device.queue.writeBuffer(this.occluderUniform, 0, data as unknown as Float32Array<ArrayBuffer>);
  }

  /** Returns true if any single occluder rect covers ≥95% of UV space. */
  isFullyOccluded(): boolean {
    return this.occluderRects.some(r => r.w * r.h >= 0.95);
  }

  getOccluderRects(): { x: number; y: number; w: number; h: number }[] {
    return this.occluderRects;
  }

  // ── Public API: enable/disable ────────────────────────────────────────────

  setEnabled(id: EffectId, enabled: boolean): void {
    this.enabled[id] = enabled;
  }

  // ── Public API: per-effect setters ────────────────────────────────────────

  setDOFFocusDist(v: number): void { this.dofFocusDist = v; }
  setDOFFocusRange(v: number): void { this.dofFocusRange = v; }
  setDOFMaxBlur(v: number): void { this.dofMaxBlur = v; }
  setDOFBokehShape(v: number): void { this.dofBokehShape = Math.floor(v); }
  setDOFSampleCount(v: number): void { this.dofSampleCount = Math.floor(v); }
  setDOFNearOnly(v: boolean): void { this.dofNearOnly = v; }
  setDOFFarOnly(v: boolean): void { this.dofFarOnly = v; }
  setDOFBladeRotation(v: number): void { this.dofBladeRotation = v; }
  setAfterimageDamp(v: number): void { this.afterimageDamp = v; }
  setBloomThreshold(v: number): void { this.bloomThreshold = v; }
  setBloomStrength(v: number): void { this.bloomStrength = v; }
  setBloomMipCount(v: number): void { this.bloomMipCount = Math.max(1, Math.min(6, Math.floor(v))); }
  setBloomTint(r: number, g: number, b: number): void { this.bloomTint = [r, g, b]; }
  setBloomSoftKnee(v: number): void { this.bloomSoftKnee = v; }
  setBloomMipWeights(weights: number[]): void { this.bloomMipWeights = weights; }
  setBloomSoftThreshold(v: number): void { this.bloomSoftThreshold = v; }
  setBloomSoftSoftThreshold(v: number): void { this.bloomSoftSoftThreshold = v; }
  setBloomSoftIntensity(v: number): void { this.bloomSoftIntensity = v; }
  setExposure(v: number): void { this.exposure = v; }
  setGamma(v: number): void { this.gamma = v; }
  setContrast(v: number): void { this.contrast = v; }
  setSaturation(v: number): void { this.saturation = v; }
  setVignette(v: number): void { this.vignette = v; }
  setTAABlendFactor(v: number): void { this.taaBlendFactor = v; }
  setTAAVarianceClamp(v: boolean): void { this.taaVarianceClamp = v; }
  setJitter(x: number, y: number): void { this.taaJitterX = x; this.taaJitterY = y; }
  setSSAORadius(v: number): void { this.ssaoRadius = v; }
  setSSAOBias(v: number): void { this.ssaoBias = v; }
  setSSAOKernelSize(v: number): void { this.ssaoKernelSize = Math.floor(v); this.ssaoDirections = Math.floor(v); }
  setSSAODirections(v: number): void { this.ssaoDirections = Math.floor(v); }
  setSSAOSlices(v: number): void { this.ssaoSlices = Math.floor(v); }
  setSSAOPower(v: number): void { this.ssaoPower = v; }
  setSSAOThickness(v: number): void { this.ssaoThickness = v; }
  setSSRMaxSteps(v: number): void { this.ssrMaxSteps = Math.floor(v); }
  setSSRThickness(v: number): void { this.ssrThickness = v; }
  setSSRMaxDistance(v: number): void { this.ssrMaxDistance = v; }
  setSSRFadeStart(v: number): void { this.ssrFadeStart = v; }
  setSSRFadeEnd(v: number): void { this.ssrFadeEnd = v; }
  setSSRBinarySteps(v: number): void { this.ssrBinarySteps = Math.floor(v); }
  setSSRStride(v: number): void { this.ssrStride = v; }
  setMotionBlurIntensity(v: number): void { this.motionBlurIntensity = v; }
  setMotionBlurMaxSamples(v: number): void { this.motionBlurMaxSamples = Math.floor(v); }
  setSharpenSharpness(v: number): void { this.sharpenSharpness = v; }
  setGrainIntensity(v: number): void { this.grainIntensity = v; }
  setGrainSize(v: number): void { this.grainSize = v; }
  setGrainLuminanceAware(v: boolean): void { this.grainLuminanceAware = v; }
  setEdgesThreshold(v: number): void { this.edgesThreshold = v; }
  setEdgesOpacity(v: number): void { this.edgesOpacity = v; }
  setEdgesEdgeColor(r: number, g: number, b: number): void { this.edgesEdgeColor = [r, g, b]; }
  setLensFlareIntensity(v: number): void { this.lensFlareIntensity = v; }
  setLensFlareThreshold(v: number): void { this.lensFlareThreshold = v; }
  setLensFlareGhostCount(v: number): void { this.lensFlareGhostCount = Math.floor(v); }
  setLensFlareGhostSpacing(v: number): void { this.lensFlareGhostSpacing = v; }
  setLensFlareHaloWidth(v: number): void { this.lensFlareHaloWidth = v; }
  setLensFlareTint(r: number, g: number, b: number): void { this.lensFlareTint = [r, g, b]; }
  setPixelationPixelSize(v: number): void { this.pixelationPixelSize = Math.max(1, Math.floor(v)); }
  getPixelationPixelSize(): number { return this.pixelationPixelSize; }
  setPixelationDepthEdgeStrength(v: number): void { this.pixelationDepthEdgeStrength = v; }
  setGaussianBlurRadius(v: number): void { this.gaussianBlurRadius = v; }
  setOutlineColor(r: number, g: number, b: number): void { this.outlineColor = [r, g, b]; }
  setOutlineWidth(v: number): void { this.outlineWidth = v; }
  setOutlineOpacity(v: number): void { this.outlineOpacity = v; }
  setHighlightIntensity(v: number): void { this.highlightIntensity = v; }
  setHighlightInnerOpacity(v: number): void { this.highlightInnerOpacity = v; }
  setHighlightBlurRadius(v: number): void { this.highlightBlurRadius = v; }
  setGlowIntensity(v: number): void { this.glowIntensity = v; }
  setGlowBlurRadius(v: number): void { this.glowBlurRadius = v; }
  setASCIICellSize(v: number): void { this.asciiCellSize = Math.max(2, Math.floor(v)); }
  setASCIIUseColor(v: boolean): void { this.asciiUseColor = v ? 1.0 : 0.0; }
  // ── New effect setters ──
  setLUT(data: Uint8Array, size: number): void {
    this.lutSize = size;
    this.lutTexture?.destroy();
    this.lutTexture = this.device.createTexture({
      dimension: "3d",
      size: [size, size, size], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Copy into a fresh ArrayBuffer to satisfy GPUAllowSharedBufferSource typing
    const buf = new Uint8Array(data.length);
    buf.set(data);
    this.device.queue.writeTexture(
      { texture: this.lutTexture }, buf.buffer,
      { bytesPerRow: size * 4, rowsPerImage: size }, [size, size, size],
    );
    this.lutView = this.lutTexture.createView({ dimension: "3d" });
  }
  setLUTEnabled(v: boolean): void { this.lutEnabled = v; }
  setWhiteBalance(temperature: number, tint: number): void { this.wbTemperature = temperature; this.wbTint = tint; }
  setChannelMixer(rr: number, rg: number, rb: number, gr: number, gg: number, gb: number, br: number, bg: number, bb: number): void {
    this.cmWeights = [rr, rg, rb, gr, gg, gb, br, bg, bb];
  }
  setChannelMixerMonochrome(v: boolean): void { this.cmMonochrome = v; }
  setSplitTone(shadowR: number, shadowG: number, shadowB: number, highlightR: number, highlightG: number, highlightB: number, balance: number): void {
    this.stShadow = [shadowR, shadowG, shadowB];
    this.stHighlight = [highlightR, highlightG, highlightB];
    this.stBalance = balance;
  }
  setChromaticAberration(intensity: number, start: number, end: number): void {
    this.caIntensity = intensity; this.caStart = start; this.caEnd = end;
  }
  setChromaticAberrationCenter(x: number, y: number): void { this.caCenterX = x; this.caCenterY = y; }
  setLensDistortion(intensity: number, scale: number, chromaSplit: number): void {
    this.ldIntensity = intensity; this.ldScale = scale; this.ldChromaSplit = chromaSplit;
  }
  setHalftone(cellSize: number, dotScale: number, angle: number, monochrome: boolean): void {
    this.htCellSize = cellSize; this.htDotScale = dotScale; this.htAngle = angle; this.htMonochrome = monochrome;
  }
  setDithering(mode: number, strength: number, levels: number): void {
    this.dMode = Math.floor(mode); this.dStrength = strength; this.dLevels = Math.floor(levels);
  }
  setWatercolor(edgeStrength: number, paperScale: number, blend: number): void {
    this.wcEdgeStrength = edgeStrength; this.wcPaperScale = paperScale; this.wcBlend = blend;
  }

  // ── Public API: per-frame inputs ──────────────────────────────────────────

  update(dt: number): void {
    this.grainTime += dt;
  }

  setCameraMatrices(proj: Float32Array, invProj: Float32Array, view: Float32Array): void {
    this.camProj = proj; this.camInvProj = invProj; this.camView = view;
  }

  setLightScreenPos(x: number, y: number): void {
    this.lightScreenPos = [x, y];
  }

  // ── Target management ─────────────────────────────────────────────────────

  private needsNormals(): boolean { return this.enabled["edges"] || this.enabled["ssao"] || this.enabled["ssr"]; }
  private needsVelocity(): boolean { return this.enabled["taa"] || this.enabled["motion-blur"]; }
  private needsMask(): boolean { return this.enabled["outline"] || this.enabled["highlight"] || this.enabled["glow"]; }

  private effectsChanged(): boolean {
    for (const id of ALL_EFFECTS) {
      if (this.enabled[id] !== this.prevEnabled[id]) {
        this.prevEnabled = { ...this.enabled };
        return true;
      }
    }
    return false;
  }

  ensureTargets(w: number, h: number): void {
    const sizeChanged = (w !== this.texW || h !== this.texH || !this.sceneColor);
    const fxChanged = this.effectsChanged();
    if (!sizeChanged && !fxChanged) return;

    if (sizeChanged) {
      this.destroyAllTargets();
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
      this.sceneColor = this.device.createTexture({ size: [w, h], format: HDR_FORMAT, usage });
      this.sceneDepth = this.device.createTexture({ size: [w, h], format: this.depthFormat, usage });
      this.pingPong[0] = this.device.createTexture({ size: [w, h], format: HDR_FORMAT, usage });
      this.pingPong[1] = this.device.createTexture({ size: [w, h], format: HDR_FORMAT, usage });
    }

    // Always (re)create optional targets when effects or size change
    this.destroyOptionalTargets();
    this.createOptionalTargets(w, h);

    this.texW = w; this.texH = h;
  }

  private createOptionalTargets(w: number, h: number): void {
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const mkTex = (fmt: GPUTextureFormat, tw: number, th: number): GPUTexture =>
      this.device.createTexture({ size: [tw, th], format: fmt, usage });

    if (this.needsNormals()) this.sceneNormals = mkTex("rgba8unorm", w, h);
    if (this.needsVelocity()) this.sceneVelocity = mkTex("rg16float", w, h);
    if (this.needsMask()) this.sceneMask = mkTex("rgba8unorm", w, h);
    if (this.enabled["taa"]) { this.taaHistory = mkTex(HDR_FORMAT, w, h); this.taaHistory2 = mkTex(HDR_FORMAT, w, h); }
    if (this.enabled["afterimage"]) this.afterimageTex = mkTex(HDR_FORMAT, w, h);
    if (this.enabled["bloom"]) {
      const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
      this.bloomBright = mkTex(HDR_FORMAT, hw, hh);
      this.bloomBlurH = mkTex(HDR_FORMAT, hw, hh);
      this.bloomBlurV = mkTex(HDR_FORMAT, hw, hh);
      // Multi-MIP pyramid: bloomMip[0] = ½res, [1] = ¼res, [2] = ⅛res, [3] = 1/16, [4] = 1/32
      this.bloomMip = [];
      let mw = hw, mh = hh;
      for (let i = 0; i < this.bloomMipCount; i++) {
        this.bloomMip.push(mkTex(HDR_FORMAT, mw, mh));
        mw = Math.max(1, mw >> 1);
        mh = Math.max(1, mh >> 1);
      }
    }
    if (this.enabled["bloom-soft"]) {
      const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
      this.halfResA = mkTex(HDR_FORMAT, hw, hh);
      this.halfResB = mkTex(HDR_FORMAT, hw, hh);
    }
    if (this.enabled["ssao"]) { this.ssaoA = mkTex(HDR_FORMAT, w, h); this.ssaoB = mkTex(HDR_FORMAT, w, h); }
    if (this.enabled["gaussian-blur"]) { this.blurA = mkTex(HDR_FORMAT, w, h); this.blurB = mkTex(HDR_FORMAT, w, h); }
    if (this.enabled["highlight"]) { this.blurA = this.blurA ?? mkTex(HDR_FORMAT, w, h); this.blurB = this.blurB ?? mkTex(HDR_FORMAT, w, h); }
    if (this.enabled["glow"]) { this.blurA = this.blurA ?? mkTex(HDR_FORMAT, w, h); this.blurB = this.blurB ?? mkTex(HDR_FORMAT, w, h); }
  }

  private destroyOptionalTargets(): void {
    const destroy = (t: GPUTexture | null) => { t?.destroy(); };
    destroy(this.sceneNormals); this.sceneNormals = null;
    destroy(this.sceneVelocity); this.sceneVelocity = null;
    destroy(this.sceneMask); this.sceneMask = null;
    destroy(this.taaHistory); this.taaHistory = null;
    destroy(this.taaHistory2); this.taaHistory2 = null;
    destroy(this.afterimageTex); this.afterimageTex = null;
    destroy(this.bloomBright); this.bloomBright = null;
    destroy(this.bloomBlurH); this.bloomBlurH = null;
    destroy(this.bloomBlurV); this.bloomBlurV = null;
    for (const m of this.bloomMip) m.destroy();
    this.bloomMip = [];
    destroy(this.halfResA); this.halfResA = null;
    destroy(this.halfResB); this.halfResB = null;
    destroy(this.ssaoA); this.ssaoA = null;
    destroy(this.ssaoB); this.ssaoB = null;
    destroy(this.blurA); this.blurA = null;
    destroy(this.blurB); this.blurB = null;
    this.bloomSoftResult = null;
  }

  private destroyAllTargets(): void {
    this.destroyOptionalTargets();
    this.sceneColor?.destroy(); this.sceneColor = null;
    this.sceneDepth?.destroy(); this.sceneDepth = null;
    this.pingPong[0]?.destroy(); this.pingPong[0] = null;
    this.pingPong[1]?.destroy(); this.pingPong[1] = null;
  }

  // ── Target getters (game renders into these) ──────────────────────────────

  getSceneColorView(): GPUTextureView {
    if (!this.sceneColor) throw new Error("PostProcess targets not created");
    return this.sceneColor.createView();
  }

  getSceneDepthView(): GPUTextureView {
    if (!this.sceneDepth) throw new Error("PostProcess targets not created");
    return this.sceneDepth.createView();
  }

  getSceneNormalsView(): GPUTextureView {
    if (!this.sceneNormals) throw new Error("Normals target not created — enable edges/ssao/ssr first");
    return this.sceneNormals.createView();
  }

  getSceneVelocityView(): GPUTextureView {
    if (!this.sceneVelocity) throw new Error("Velocity target not created — enable taa/motion-blur first");
    return this.sceneVelocity.createView();
  }

  getSceneMaskView(): GPUTextureView {
    if (!this.sceneMask) throw new Error("Mask target not created — enable outline/highlight/glow first");
    return this.sceneMask.createView();
  }

  // ── Main chain ────────────────────────────────────────────────────────────

  applyChain(
    encoder: GPUCommandEncoder,
    depthView: GPUTextureView | null,
    canvasView: GPUTextureView,
    w: number, h: number,
  ): void {
    const active = CHAIN_ORDER.filter(id => this.enabled[id]);
    if (active.length === 0) return;

    const dv = depthView ?? this.sceneDepth?.createView() ?? null;
    let inputView = this.sceneColor!.createView();
    let pingIdx = 0;

    for (let i = 0; i < active.length; i++) {
      const effect = active[i];
      const outputTex = this.pingPong[pingIdx]!;
      const outputView = outputTex.createView();

      this.applyEffect(encoder, effect, inputView, outputView, dv, w, h);

      // Post-effect side effects
      if (effect === "afterimage") {
        encoder.copyTextureToTexture({ texture: outputTex }, { texture: this.afterimageTex! }, [w, h]);
      } else if (effect === "taa") {
        encoder.copyTextureToTexture({ texture: outputTex }, { texture: this.taaHistory2! }, [w, h]);
        const tmp = this.taaHistory; this.taaHistory = this.taaHistory2; this.taaHistory2 = tmp;
      }

      inputView = outputView;
      pingIdx = 1 - pingIdx;
    }

    // Blit final result to canvas
    this.applyBlit(encoder, inputView, canvasView, w, h);
  }

  private applyEffect(
    encoder: GPUCommandEncoder,
    effect: EffectId,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    depthView: GPUTextureView | null,
    w: number, h: number,
  ): void {
    switch (effect) {
      case "fxaa": this.applyCC(encoder, "fxaa", inputView, outputView, w, h, [1/w, 1/h]); break;
      case "sobel": this.applyCC(encoder, "sobel", inputView, outputView, w, h, [1/w, 1/h]); break;
      case "sharpen": this.applyCC(encoder, "sharpen", inputView, outputView, w, h, [1/w, 1/h, this.sharpenSharpness]); break;
      case "grain": this.applyCC(encoder, "grain", inputView, outputView, w, h, [1/w, 1/h, this.grainIntensity, this.grainSize, this.grainLuminanceAware ? 1 : 0, this.grainTime]); break;
      case "dof": this.applyCD(encoder, "dof", inputView, outputView, depthView!, w, h, [1/w, 1/h, this.dofFocusDist, this.dofFocusRange, this.dofMaxBlur, this.dofBokehShape, this.dofSampleCount, this.dofNearOnly ? 1 : 0, this.dofFarOnly ? 1 : 0, this.dofBladeRotation, 0, 0, 0, 0, 0, 0]); break;
      case "pixelation": this.applyCD(encoder, "pixelation", inputView, outputView, depthView!, w, h, [1/w, 1/h, this.pixelationPixelSize, this.pixelationDepthEdgeStrength, w, h]); break;
      case "lens-flare": this.applyCD(encoder, "lens-flare", inputView, outputView, depthView!, w, h, [this.lightScreenPos[0], this.lightScreenPos[1], this.lensFlareIntensity, this.lensFlareThreshold, this.lensFlareGhostCount, this.lensFlareGhostSpacing, this.lensFlareHaloWidth, 16, 0, 0, 0, 0, ...this.lensFlareTint, 0]); break;
      case "afterimage": this.applyAfterimage(encoder, inputView, outputView, w, h); break;
      case "ascii": this.applyASCII(encoder, inputView, outputView, w, h); break;
      case "bloom": this.applyBloom(encoder, inputView, outputView, w, h); break;
      case "bloom-soft": this.applyBloomSoft(encoder, inputView, outputView, w, h); break;
      case "tonemap": this.applyTonemap(encoder, inputView, outputView, w, h); break;
      case "taa": this.applyTAA(encoder, inputView, outputView, w, h); break;
      case "ssao": this.applySSAO(encoder, inputView, outputView, depthView!, w, h); break;
      case "ssr": this.applySSR(encoder, inputView, outputView, depthView!, w, h); break;
      case "motion-blur": this.applyMotionBlur(encoder, inputView, outputView, depthView!, w, h); break;
      case "edges": this.applyEdges(encoder, inputView, outputView, depthView!, w, h); break;
      case "gaussian-blur": this.applyGaussianBlur(encoder, inputView, outputView, w, h); break;
      case "outline": this.applyOutline(encoder, inputView, outputView, w, h); break;
      case "highlight": this.applyHighlight(encoder, inputView, outputView, w, h); break;
      case "glow": this.applyGlow(encoder, inputView, outputView, w, h); break;
      // New effects
      case "lut": this.applyLUT(encoder, inputView, outputView, w, h); break;
      case "white-balance": this.applyCC(encoder, "white-balance", inputView, outputView, w, h, [this.wbTemperature, this.wbTint, 0, 0, 0, 0, 0, 0]); break;
      case "channel-mixer": this.applyCC(encoder, "channel-mixer", inputView, outputView, w, h, [...this.cmWeights, this.cmMonochrome ? 1 : 0, 0, 0, 0]); break;
      case "split-tone": this.applyCC(encoder, "split-tone", inputView, outputView, w, h, [...this.stShadow, ...this.stHighlight, this.stBalance, 0]); break;
      case "chromatic-aberration": this.applyCC(encoder, "chromatic-aberration", inputView, outputView, w, h, [1/w, 1/h, this.caIntensity, this.caStart, this.caEnd, this.caCenterX, this.caCenterY, 0]); break;
      case "lens-distortion": this.applyCC(encoder, "lens-distortion", inputView, outputView, w, h, [1/w, 1/h, this.ldIntensity, this.ldScale, this.ldChromaSplit, 0, 0, 0]); break;
      case "halftone": this.applyCC(encoder, "halftone", inputView, outputView, w, h, [1/w, 1/h, this.htCellSize, this.htDotScale, this.htAngle, this.htMonochrome ? 1 : 0, 0, 0]); break;
      case "dithering": this.applyDithering(encoder, inputView, outputView, w, h); break;
      case "watercolor": this.applyWatercolor(encoder, inputView, outputView, w, h); break;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private wu(key: string, data: Float32Array): void {
    this.device.queue.writeBuffer(this.uniforms[key], 0, data as unknown as Float32Array<ArrayBuffer>);
  }

  private bg(layout: GPUBindGroupLayout, entries: GPUBindGroupEntry[]): GPUBindGroup {
    return this.device.createBindGroup({ layout, entries });
  }

  private pass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
    outputView: GPUTextureView,
    w: number, h: number,
  ): void {
    const p = encoder.beginRenderPass({
      colorAttachments: [{ view: outputView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
    });
    p.setViewport(0, 0, w, h, 0, 1);
    p.setScissorRect(0, 0, w, h);
    p.setPipeline(pipeline);
    p.setBindGroup(0, bindGroup);
    p.setBindGroup(1, this.occluderBindGroup);
    p.draw(3);
    p.end();
  }

  // ── Simple cc-layout effects (color + dummy + sampler + uniform) ──────────

  private applyCC(
    encoder: GPUCommandEncoder, key: string,
    inputView: GPUTextureView, outputView: GPUTextureView,
    w: number, h: number, data: number[],
  ): void {
    this.wu(key, new Float32Array(data));
    const bg = this.bg(this.ccLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.dummyTex.createView() },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms[key] } },
    ]);
    this.pass(encoder, this.pipelines[key], bg, outputView, w, h);
  }

  // ── Simple cd-layout effects (color + depth + sampler + uniform) ──────────

  private applyCD(
    encoder: GPUCommandEncoder, key: string,
    inputView: GPUTextureView, outputView: GPUTextureView,
    depthView: GPUTextureView,
    w: number, h: number, data: number[],
  ): void {
    this.wu(key, new Float32Array(data));
    const bg = this.bg(this.cdLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: depthView },
      { binding: 2, resource: this.nearestSampler },
      { binding: 3, resource: { buffer: this.uniforms[key] } },
    ]);
    this.pass(encoder, this.pipelines[key], bg, outputView, w, h);
  }

  // ── Afterimage ────────────────────────────────────────────────────────────

  private applyAfterimage(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    this.wu("afterimage", new Float32Array([1/w, 1/h, this.afterimageDamp]));
    const bg = this.bg(this.ccLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.afterimageTex!.createView() },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["afterimage"] } },
    ]);
    this.pass(encoder, this.pipelines["afterimage"], bg, outputView, w, h);
  }

  // ── ASCII ─────────────────────────────────────────────────────────────────

  private applyASCII(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    this.wu("ascii", new Float32Array([1/w, 1/h, this.asciiCellSize, this.asciiUseColor, w, h]));
    const bg = this.bg(this.ccLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.glyphTex!.createView() },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["ascii"] } },
    ]);
    this.pass(encoder, this.pipelines["ascii"], bg, outputView, w, h);
  }

  // ── Bloom (multi-MIP pyramid: downsample cascade + upsample composite) ───

  private applyBloom(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    const dummy = this.dummyTex.createView();
    const mipCount = this.bloomMip.length;
    if (mipCount === 0) {
      // Fallback: no MIP targets allocated — blit input to output
      this.applyBlitHDR(encoder, inputView, outputView, w, h);
      return;
    }

    // Track dimensions for each MIP level
    const mipW: number[] = [Math.max(1, w >> 1)];
    const mipH: number[] = [Math.max(1, h >> 1)];
    for (let i = 1; i < mipCount; i++) {
      mipW.push(Math.max(1, mipW[i - 1] >> 1));
      mipH.push(Math.max(1, mipH[i - 1] >> 1));
    }

    // ── Downsample cascade: full → ½ → ¼ → ⅛ → ... ──
    // First downsample: bright-pass extraction from the full-res input
    this.wu("bloom-downsample", new Float32Array([
      1 / w, 1 / h, 1.0, this.bloomThreshold, this.bloomSoftKnee, 0, 0, 0,
    ]));
    this.pass(encoder, this.pipelines["bloom-downsample"], this.bg(this.ccLayout, [
      { binding: 0, resource: inputView }, { binding: 1, resource: dummy },
      { binding: 2, resource: this.linearSampler }, { binding: 3, resource: { buffer: this.uniforms["bloom-downsample"] } },
    ]), this.bloomMip[0].createView(), mipW[0], mipH[0]);

    // Subsequent downsamples: plain downsample from previous MIP
    for (let i = 1; i < mipCount; i++) {
      const srcW = mipW[i - 1], srcH = mipH[i - 1];
      this.wu("bloom-downsample", new Float32Array([
        1 / srcW, 1 / srcH, 0.0, this.bloomThreshold, this.bloomSoftKnee, 0, 0, 0,
      ]));
      this.pass(encoder, this.pipelines["bloom-downsample"], this.bg(this.ccLayout, [
        { binding: 0, resource: this.bloomMip[i - 1].createView() }, { binding: 1, resource: dummy },
        { binding: 2, resource: this.linearSampler }, { binding: 3, resource: { buffer: this.uniforms["bloom-downsample"] } },
      ]), this.bloomMip[i].createView(), mipW[i], mipH[i]);
    }

    // ── Upsample cascade: smallest MIP → ... → ½ → composite to output ──
    // Start from the smallest MIP, progressively upsample + additively blend
    // into the next larger MIP. The upsample shader reads the lower-res MIP
    // and adds it to the higher-res MIP (baseTex binding).
    for (let i = mipCount - 1; i >= 1; i--) {
      const srcW = mipW[i], srcH = mipH[i];
      const dstW = mipW[i - 1], dstH = mipH[i - 1];
      const weight = this.bloomMipWeights[Math.min(i, this.bloomMipWeights.length - 1)] ?? 0.5;
      this.wu("bloom-upsample", new Float32Array([
        1 / srcW, 1 / srcH, weight, 0,
        this.bloomTint[0], this.bloomTint[1], this.bloomTint[2], 0,
      ]));
      this.pass(encoder, this.pipelines["bloom-upsample"], this.bg(this.ccLayout, [
        { binding: 0, resource: this.bloomMip[i].createView() },
        { binding: 1, resource: this.bloomMip[i - 1].createView() },
        { binding: 2, resource: this.linearSampler },
        { binding: 3, resource: { buffer: this.uniforms["bloom-upsample"] } },
      ]), this.bloomMip[i - 1].createView(), dstW, dstH);
    }

    // Final composite: upsample ½-res bloom → full-res, add to scene color
    const srcW = mipW[0], srcH = mipH[0];
    const finalWeight = this.bloomStrength * (this.bloomMipWeights[0] ?? 0.5);
    this.wu("bloom-upsample", new Float32Array([
      1 / srcW, 1 / srcH, finalWeight, 0,
      this.bloomTint[0], this.bloomTint[1], this.bloomTint[2], 0,
    ]));
    // For the final pass, baseTex = inputView (scene color), output = outputView
    // We need to read inputView as base — but the upsample shader writes base+bloom.
    // Use a temp: blit input to pingPong[0], then upsample into outputView.
    this.applyBlitHDR(encoder, inputView, this.pingPong[0]!.createView(), w, h);
    this.pass(encoder, this.pipelines["bloom-upsample"], this.bg(this.ccLayout, [
      { binding: 0, resource: this.bloomMip[0].createView() },
      { binding: 1, resource: this.pingPong[0]!.createView() },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["bloom-upsample"] } },
    ]), outputView, w, h);
  }

  // ── Bloom-soft (bright + blur H + blur V, stores result for tonemap) ──────

  private applyBloomSoft(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const dummy = this.dummyTex.createView();

    // Bright pass (dirX > 1.0 triggers bright-pass extraction)
    this.wu("bloom-soft", new Float32Array([1/w, 1/h, 2.0, 0.0, this.bloomSoftThreshold, this.bloomSoftSoftThreshold]));
    this.pass(encoder, this.pipelines["bloom-soft"], this.bg(this.ccLayout, [
      { binding: 0, resource: inputView }, { binding: 1, resource: dummy },
      { binding: 2, resource: this.linearSampler }, { binding: 3, resource: { buffer: this.uniforms["bloom-soft"] } },
    ]), this.halfResA!.createView(), hw, hh);

    // Blur H
    this.wu("bloom-soft", new Float32Array([1/hw, 1/hh, 1.0, 0.0, this.bloomSoftThreshold, this.bloomSoftSoftThreshold]));
    this.pass(encoder, this.pipelines["bloom-soft"], this.bg(this.ccLayout, [
      { binding: 0, resource: this.halfResA!.createView() }, { binding: 1, resource: dummy },
      { binding: 2, resource: this.linearSampler }, { binding: 3, resource: { buffer: this.uniforms["bloom-soft"] } },
    ]), this.halfResB!.createView(), hw, hh);

    // Blur V
    this.wu("bloom-soft", new Float32Array([1/hw, 1/hh, 0.0, 1.0, this.bloomSoftThreshold, this.bloomSoftSoftThreshold]));
    this.pass(encoder, this.pipelines["bloom-soft"], this.bg(this.ccLayout, [
      { binding: 0, resource: this.halfResB!.createView() }, { binding: 1, resource: dummy },
      { binding: 2, resource: this.linearSampler }, { binding: 3, resource: { buffer: this.uniforms["bloom-soft"] } },
    ]), this.halfResA!.createView(), hw, hh);

    // Store result for tonemap
    this.bloomSoftResult = this.halfResA!.createView();

    // Blit input to output (bloom-soft doesn't composite — tonemap does that)
    // Use HDR blit since outputView is an HDR ping-pong texture in the chain
    this.applyBlitHDR(encoder, inputView, outputView, w, h);
  }

  // ── Tonemap (color + bloom + ACES + exposure/gamma/contrast/sat/vignette) ─

  private applyTonemap(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    this.wu("tonemap", new Float32Array([
      this.exposure, this.bloomSoftIntensity, this.gamma, this.contrast, this.saturation, this.vignette, 0, 0,
    ]));
    const bloomView = this.bloomSoftResult ?? this.dummyTex.createView();
    const bg = this.bg(this.ccLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: bloomView },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["tonemap"] } },
    ]);
    this.pass(encoder, this.pipelines["tonemap"], bg, outputView, w, h);
  }

  // ── TAA (color + velocity + history + YCoCg neighborhood clamp) ───────────

  private applyTAA(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    // When occluder rects changed, use blendFactor=1.0 for one frame to
    // ignore stale history in the previously-occluded region (standard TAA
    // reset pattern, same as camera cuts).
    const blend = this.taaHistoryReset ? 1.0 : this.taaBlendFactor;
    this.wu("taa", new Float32Array([1/w, 1/h, blend, this.taaVarianceClamp ? 1 : 0, this.taaJitterX, this.taaJitterY, 0, 0]));
    const bg = this.bg(this.cvvhLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.sceneVelocity!.createView() },
      { binding: 2, resource: this.taaHistory!.createView() },
      { binding: 3, resource: this.linearSampler },
      { binding: 4, resource: { buffer: this.uniforms["taa"] } },
    ]);
    this.pass(encoder, this.pipelines["taa"], bg, outputView, w, h);
    this.taaHistoryReset = false;
  }

  // ── SSAO (compute + blur + composite) ─────────────────────────────────────

  private applySSAO(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, depthView: GPUTextureView, w: number, h: number): void {
    // Write SSAO uniform (matrices + params)
    this.writeSSAOUniform(w, h);

    // Compute SSAO
    const bg0 = this.bg(this.dnfnLayout, [
      { binding: 0, resource: depthView },
      { binding: 1, resource: this.sceneNormals!.createView() },
      { binding: 2, resource: this.noiseTex!.createView() },
      { binding: 3, resource: this.nearestSampler },
      { binding: 4, resource: { buffer: this.uniforms["ssao"] } },
    ]);
    this.pass(encoder, this.pipelines["ssao"], bg0, this.ssaoA!.createView(), w, h);

    // Blur SSAO
    this.wu("ssao-blur", new Float32Array([1/w, 1/h]));
    const bg1 = this.bg(this.cdLayout, [
      { binding: 0, resource: this.ssaoA!.createView() },
      { binding: 1, resource: depthView },
      { binding: 2, resource: this.nearestSampler },
      { binding: 3, resource: { buffer: this.uniforms["ssao-blur"] } },
    ]);
    this.pass(encoder, this.pipelines["ssao-blur"], bg1, this.ssaoB!.createView(), w, h);

    // Composite AO × color
    this.wu("ssao-composite", new Float32Array([1/w, 1/h]));
    const bg2 = this.bg(this.ccLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.ssaoB!.createView() },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["ssao-composite"] } },
    ]);
    this.pass(encoder, this.pipelines["ssao-composite"], bg2, outputView, w, h);
  }

  private writeSSAOUniform(w: number, h: number): void {
    // Layout: invProjection(16) + view(16) + projection(16) + directions + radius + bias
    //         + noiseScale(2) + screenSize(2) + power + thickness + slices + pad(2) = 56 floats
    const data = new Float32Array(64);
    if (this.camInvProj) data.set(this.camInvProj, 0);
    if (this.camView) data.set(this.camView, 16);
    if (this.camProj) data.set(this.camProj, 32);
    data[48] = this.ssaoDirections;
    data[49] = this.ssaoRadius;
    data[50] = this.ssaoBias;
    data[51] = 4; // noiseSize X
    data[52] = 4; // noiseSize Y
    data[53] = w;
    data[54] = h;
    data[55] = this.ssaoPower;
    data[56] = this.ssaoThickness;
    data[57] = this.ssaoSlices;
    this.device.queue.writeBuffer(this.uniforms["ssao"], 0, data as unknown as Float32Array<ArrayBuffer>);
  }

  // ── SSR (color + normal + depth + ray march) ──────────────────────────────

  private applySSR(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, depthView: GPUTextureView, w: number, h: number): void {
    const data = new Float32Array(64);
    if (this.camInvProj) data.set(this.camInvProj, 0);
    if (this.camView) data.set(this.camView, 16);
    if (this.camProj) data.set(this.camProj, 32);
    data[48] = this.ssrMaxSteps;
    data[49] = this.ssrThickness;
    data[50] = this.ssrMaxDistance;
    data[51] = this.ssrFadeStart;
    data[52] = this.ssrFadeEnd;
    data[53] = this.ssrBinarySteps;
    data[54] = this.ssrStride;
    this.device.queue.writeBuffer(this.uniforms["ssr"], 0, data as unknown as Float32Array<ArrayBuffer>);

    const bg = this.bg(this.cvdLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.sceneNormals!.createView() },
      { binding: 2, resource: depthView },
      { binding: 3, resource: this.nearestSampler },
      { binding: 4, resource: { buffer: this.uniforms["ssr"] } },
    ]);
    this.pass(encoder, this.pipelines["ssr"], bg, outputView, w, h);
  }

  // ── Motion blur (color + velocity + depth) ────────────────────────────────

  private applyMotionBlur(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, depthView: GPUTextureView, w: number, h: number): void {
    this.wu("motion-blur", new Float32Array([1/w, 1/h, this.motionBlurIntensity, this.motionBlurMaxSamples]));
    const bg = this.bg(this.cvdLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.sceneVelocity!.createView() },
      { binding: 2, resource: depthView },
      { binding: 3, resource: this.nearestSampler },
      { binding: 4, resource: { buffer: this.uniforms["motion-blur"] } },
    ]);
    this.pass(encoder, this.pipelines["motion-blur"], bg, outputView, w, h);
  }

  // ── Edges (color + normal + depth) ────────────────────────────────────────

  private applyEdges(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, depthView: GPUTextureView, w: number, h: number): void {
    this.wu("edges", new Float32Array([1/w, 1/h, this.edgesThreshold, this.edgesOpacity, 0, 0, 0, 0, ...this.edgesEdgeColor, 0, 0]));
    const bg = this.bg(this.cvdLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.sceneNormals!.createView() },
      { binding: 2, resource: depthView },
      { binding: 3, resource: this.nearestSampler },
      { binding: 4, resource: { buffer: this.uniforms["edges"] } },
    ]);
    this.pass(encoder, this.pipelines["edges"], bg, outputView, w, h);
  }

  // ── Gaussian blur (two-pass: H then V) ────────────────────────────────────

  private applyGaussianBlur(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    const dummy = this.dummyTex.createView();
    // H pass
    this.wu("gaussian-blur", new Float32Array([1/w, 1/h, 1.0, 0.0, this.gaussianBlurRadius]));
    this.pass(encoder, this.pipelines["gaussian-blur"], this.bg(this.ccLayout, [
      { binding: 0, resource: inputView }, { binding: 1, resource: dummy },
      { binding: 2, resource: this.linearSampler }, { binding: 3, resource: { buffer: this.uniforms["gaussian-blur"] } },
    ]), this.blurA!.createView(), w, h);
    // V pass
    this.wu("gaussian-blur", new Float32Array([1/w, 1/h, 0.0, 1.0, this.gaussianBlurRadius]));
    this.pass(encoder, this.pipelines["gaussian-blur"], this.bg(this.ccLayout, [
      { binding: 0, resource: this.blurA!.createView() }, { binding: 1, resource: dummy },
      { binding: 2, resource: this.linearSampler }, { binding: 3, resource: { buffer: this.uniforms["gaussian-blur"] } },
    ]), outputView, w, h);
  }

  // ── Outline (color + mask) ────────────────────────────────────────────────

  private applyOutline(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    this.wu("outline", new Float32Array([1/w, 1/h, this.outlineWidth, this.outlineOpacity, 0, 0, 0, 0, ...this.outlineColor, 0, 0]));
    const bg = this.bg(this.ccLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.sceneMask!.createView() },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["outline"] } },
    ]);
    this.pass(encoder, this.pipelines["outline"], bg, outputView, w, h);
  }

  // ── Highlight (blur H + blur V + composite) ───────────────────────────────

  private applyHighlight(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    const dummy = this.dummyTex.createView();
    const maskView = this.sceneMask!.createView();

    // Blur H
    this.wu("highlight-blur", new Float32Array([1/w, 1/h, 1.0, 0.0, this.highlightBlurRadius]));
    this.pass(encoder, this.pipelines["highlight-blur"], this.bg(this.ccLayout, [
      { binding: 0, resource: maskView }, { binding: 1, resource: dummy },
      { binding: 2, resource: this.linearSampler }, { binding: 3, resource: { buffer: this.uniforms["highlight-blur"] } },
    ]), this.blurA!.createView(), w, h);

    // Blur V
    this.wu("highlight-blur", new Float32Array([1/w, 1/h, 0.0, 1.0, this.highlightBlurRadius]));
    this.pass(encoder, this.pipelines["highlight-blur"], this.bg(this.ccLayout, [
      { binding: 0, resource: this.blurA!.createView() }, { binding: 1, resource: dummy },
      { binding: 2, resource: this.linearSampler }, { binding: 3, resource: { buffer: this.uniforms["highlight-blur"] } },
    ]), this.blurB!.createView(), w, h);

    // Composite
    this.wu("highlight-composite", new Float32Array([this.highlightIntensity, this.highlightInnerOpacity]));
    const bg = this.bg(this.cvvhLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.blurB!.createView() },
      { binding: 2, resource: maskView },
      { binding: 3, resource: this.linearSampler },
      { binding: 4, resource: { buffer: this.uniforms["highlight-composite"] } },
    ]);
    this.pass(encoder, this.pipelines["highlight-composite"], bg, outputView, w, h);
  }

  // ── Glow (blur H + blur V + composite) ────────────────────────────────────

  private applyGlow(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    const dummy = this.dummyTex.createView();
    const maskView = this.sceneMask!.createView();

    // Blur H
    this.wu("glow-blur", new Float32Array([1/w, 1/h, 1.0, 0.0, this.glowBlurRadius]));
    this.pass(encoder, this.pipelines["glow-blur"], this.bg(this.ccLayout, [
      { binding: 0, resource: maskView }, { binding: 1, resource: dummy },
      { binding: 2, resource: this.linearSampler }, { binding: 3, resource: { buffer: this.uniforms["glow-blur"] } },
    ]), this.blurA!.createView(), w, h);

    // Blur V
    this.wu("glow-blur", new Float32Array([1/w, 1/h, 0.0, 1.0, this.glowBlurRadius]));
    this.pass(encoder, this.pipelines["glow-blur"], this.bg(this.ccLayout, [
      { binding: 0, resource: this.blurA!.createView() }, { binding: 1, resource: dummy },
      { binding: 2, resource: this.linearSampler }, { binding: 3, resource: { buffer: this.uniforms["glow-blur"] } },
    ]), this.blurB!.createView(), w, h);

    // Composite
    this.wu("glow-composite", new Float32Array([this.glowIntensity]));
    const bg = this.bg(this.ccLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.blurB!.createView() },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["glow-composite"] } },
    ]);
    this.pass(encoder, this.pipelines["glow-composite"], bg, outputView, w, h);
  }

  // ── LUT (3D color grading — dedicated lutLayout with texture_3d) ──────────

  private applyLUT(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    if (!this.lutView) {
      // No LUT loaded — blit input to output (HDR ping-pong in chain)
      this.applyBlitHDR(encoder, inputView, outputView, w, h);
      return;
    }
    this.wu("lut", new Float32Array([this.lutEnabled ? 1 : 0, this.lutSize, 0, 0]));
    const bg = this.bg(this.lutLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.lutView },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["lut"] } },
    ]);
    this.pass(encoder, this.pipelines["lut"], bg, outputView, w, h);
  }

  // ── Dithering (color + noise + sampler + uniform, ccLayout) ───────────────

  private applyDithering(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    this.wu("dithering", new Float32Array([1/w, 1/h, this.dMode, this.dStrength, this.dLevels, 0, 0, 0]));
    const bg = this.bg(this.ccLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.noiseTex!.createView() },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["dithering"] } },
    ]);
    this.pass(encoder, this.pipelines["dithering"], bg, outputView, w, h);
  }

  // ── Watercolor (color + noise + sampler + uniform, ccLayout) ──────────────

  private applyWatercolor(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    this.wu("watercolor", new Float32Array([1/w, 1/h, this.wcEdgeStrength, this.wcPaperScale, this.wcBlend, 0, 0, 0]));
    const bg = this.bg(this.ccLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.noiseTex!.createView() },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["watercolor"] } },
    ]);
    this.pass(encoder, this.pipelines["watercolor"], bg, outputView, w, h);
  }

  // ── Blit (copy rgba16float → canvas format) ───────────────────────────────

  private applyBlit(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    this.wu("blit", new Float32Array([1/w, 1/h]));
    const bg = this.bg(this.ccLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.dummyTex.createView() },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["blit"] } },
    ]);
    this.pass(encoder, this.pipelines["blit"], bg, outputView, w, h);
  }

  /** HDR blit variant for intermediate chain passes (writes to rgba16float ping-pong). */
  private applyBlitHDR(encoder: GPUCommandEncoder, inputView: GPUTextureView, outputView: GPUTextureView, w: number, h: number): void {
    this.wu("blit", new Float32Array([1/w, 1/h]));
    const bg = this.bg(this.ccLayout, [
      { binding: 0, resource: inputView },
      { binding: 1, resource: this.dummyTex.createView() },
      { binding: 2, resource: this.linearSampler },
      { binding: 3, resource: { buffer: this.uniforms["blit"] } },
    ]);
    this.pass(encoder, this.pipelines["blit-hdr"], bg, outputView, w, h);
  }

  // ── Destroy ───────────────────────────────────────────────────────────────

  destroy(): void {
    this.destroyAllTargets();
    this.dummyTex?.destroy();
    this.glyphTex?.destroy();
    this.noiseTex?.destroy();
    this.lutTexture?.destroy();
    this.occluderUniform?.destroy();
    for (const key in this.uniforms) this.uniforms[key]?.destroy();
    for (const key in this.pipelines) this.pipelines[key]?.destroy?.();
  }
}
