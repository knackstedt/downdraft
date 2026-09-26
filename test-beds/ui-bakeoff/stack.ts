// ============================================================================
// stack.ts — shared interface + helpers for the ui-bakeoff test bed.
//
// Each UI stack renders the SAME component gallery (tab bar, buttons,
// checkboxes, slider, progress bar, segmented control, scroll list, text
// field, HUD mock) so the stacks can be compared visually and ergonomically.
// ============================================================================

import { createValidatedShaderModule } from "@downdraft/engine";
import { UiBlitPass } from "@downdraft/engine/libraries/pixi-ui-native";

// Linear-resolve variant of UiBlitPass: samples the UI texture through an
// rgba8unorm-srgb view so filtering/downsample happens in LINEAR space, then
// re-encodes to sRGB on write (the swapchain is gamma-space bgra8unorm).
// Without this, supersampled text edges average encoded texels — a 50%
// coverage edge lands at ~sRGB 0.5 (linear 0.21) instead of linear 0.5
// (sRGB ~0.74), which makes light text on dark look thin and dingy.
const LINEAR_BLIT_WGSL = `
struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var o: VertexOutput;
  o.clipPos = vec4(p[vi], 0.0, 1.0);
  o.uv = vec2(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return o;
}
fn srgb_encode(l: f32) -> f32 {
  if (l <= 0.0031308) { return l * 12.92; }
  return 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}
@group(0) @binding(0) var uiTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let c = textureSample(uiTex, samp, input.uv); // -srgb view → linear premul rgb
  return vec4<f32>(
    srgb_encode(c.r), srgb_encode(c.g), srgb_encode(c.b), c.a);
}
`;

class LinearBlitPass {
    private pipeline: GPURenderPipeline;
    private bindGroupLayout: GPUBindGroupLayout;
    private sampler: GPUSampler;
    constructor(private device: GPUDevice, targetFormat: GPUTextureFormat) {
        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ],
        });
        this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
        const shader = createValidatedShaderModule(device, { code: LINEAR_BLIT_WGSL, label: "LinearBlitPass" });
        this.pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            vertex: { module: shader, entryPoint: "vs_main" },
            fragment: {
                module: shader,
                entryPoint: "fs_main",
                targets: [{
                    format: targetFormat,
                    blend: {
                        color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                    },
                }],
            },
            primitive: { topology: "triangle-list" },
        });
    }
    execute(encoder: GPUCommandEncoder, targetView: GPUTextureView, uiTextureView: GPUTextureView): void {
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: targetView, loadOp: "load", storeOp: "store" }],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: uiTextureView },
                { binding: 1, resource: this.sampler },
            ],
        }));
        pass.draw(3, 1, 0, 0);
        pass.end();
    }
    dispose(): void {}
}

export const TABS = ["imui", "PixiJS", "Dioxus", "HTML/CSS", "Canvas2D", "HtmlUI"] as const;

export const LIST_ITEMS = [
    "Iron Ore", "Copper Ore", "Coal", "Stone", "Wood Plank", "Rope", "Torch",
    "Fuse", "C4 Charge", "Gold Ore", "Silver Ore", "Mushroom", "Star Shard",
    "Void Essence",
];

export interface GalleryState {
    checks: [boolean, boolean, boolean];
    segment: number;
    slider: number;      // 0-100
    progress: number;    // 0-100
    selected: number;    // list index
    hp: number;          // 0-100
    mana: number;        // 0-100
    clicks: number;
    text: string;
}

export function freshState(): GalleryState {
    return {
        checks: [true, false, true],
        segment: 1,
        slider: 65,
        progress: 42,
        selected: 2,
        hp: 78,
        mana: 55,
        clicks: 0,
        text: "Scout-7",
    };
}

export interface StackCtx {
    device: GPUDevice;
    format: GPUTextureFormat;
    /** Physical-px size of the swapchain surface. */
    width: number;
    height: number;
    /** Actions pushed up by the UI stack ("tab" = switch to payload.index). */
    onAction(action: string, payloadJson: string): void;
}

export interface UiStack {
    readonly id: string;
    readonly label: string;
    init(ctx: StackCtx): Promise<void>;
    /** Draw this stack's UI over `target` (already contains the cleared bg).
     *  Implementations own their encoder/submit. */
    frame(target: GPUTextureView): void;
    resize(width: number, height: number): void;
    dispose(): void;
    // Input — canvas physical px. Return true when the stack consumed it.
    pointerMove?(x: number, y: number): boolean;
    pointerDown?(x: number, y: number, button: number): boolean;
    pointerUp?(x: number, y: number, button: number): boolean;
    wheel?(x: number, y: number, dx: number, dy: number): boolean;
    key?(down: boolean, key: string, code: string, keyCode: number, mods: number): boolean;
}

/**
 * Uploads RGBA8 buffers into a texture and blits them over the frame —
 * the common compositing path for every CPU-rasterized stack (Dioxus wasm,
 * Blitz OSR, Canvas2D).
 */
export class RgbaBlit {
    private blitPass: { execute(e: GPUCommandEncoder, t: GPUTextureView, v: GPUTextureView): void; dispose(): void };
    private texture: GPUTexture | null = null;
    private texW = 0;
    private texH = 0;
    private linearResolve: boolean;

    constructor(private device: GPUDevice, format: GPUTextureFormat, opts?: { linearResolve?: boolean }) {
        this.linearResolve = opts?.linearResolve ?? false;
        this.blitPass = this.linearResolve
            ? new LinearBlitPass(device, format)
            : new UiBlitPass(device, format);
    }

    private ensure(w: number, h: number): GPUTexture | null {
        if (this.texture && this.texW === w && this.texH === h) return this.texture;
        this.texture?.destroy();
        this.texture = this.device.createTexture({
            size: { width: Math.max(1, w), height: Math.max(1, h) },
            format: "rgba8unorm",
            // Advertise the sRGB view so the linear-resolve blit can sample it.
            viewFormats: ["rgba8unorm-srgb"],
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        } as GPUTextureDescriptor);
        this.texW = w;
        this.texH = h;
        return this.texture;
    }

    /** Upload `rgba` (w*h*4 premultiplied bytes) and composite over target. */
    frame(target: GPUTextureView, rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): void {
        const tex = this.ensure(w, h);
        if (!tex) return;
        this.device.queue.copyExternalImageToTexture(
            { source: { data: rgba as Uint8Array, width: w, height: h } } as unknown as GPUCopyExternalImageSourceInfo,
            { texture: tex } as unknown as GPUCopyExternalImageDestInfo,
            { width: w, height: h },
        );
        this.blit(target);
    }

    /** Composite the current UI texture over target without re-uploading. */
    blit(target: GPUTextureView): void {
        if (!this.texture) return;
        const view = this.linearResolve
            ? this.texture.createView({ format: "rgba8unorm-srgb" })
            : this.texture.createView();
        const encoder = this.device.createCommandEncoder();
        this.blitPass.execute(encoder, target, view);
        this.device.queue.submit([encoder.finish()]);
    }

    dispose(): void {
        this.texture?.destroy();
        this.blitPass.dispose();
    }
}

/** Simple hit-region map for stacks without a real event system (HTML, 2D). */
export interface HitRegion {
    x: number; y: number; w: number; h: number;
    onClick?(): void;
    onDown?(x: number, y: number): void;
    onDrag?(x: number, y: number): void;
    /** Region continues receiving move events after a down (slider drags). */
    drag?: boolean;
}

export class HitMap {
    regions: HitRegion[] = [];
    private dragging: HitRegion | null = null;

    hit(x: number, y: number): HitRegion | null {
        for (let _i = 0, _it = this.regions, _n = _it.length; _i < _n; _i++) { const r = _it[_i];
            if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
        }
        return null;
    }

    pointerDown(x: number, y: number): boolean {
        const r = this.hit(x, y);
        if (!r) return false;
        r.onDown?.(x, y);
        if (r.drag) this.dragging = r;
        return true;
    }

    pointerMove(x: number, y: number): boolean {
        if (this.dragging) {
            this.dragging.onDrag?.(x, y);
            return true;
        }
        return false;
    }

    pointerUp(x: number, y: number): boolean {
        if (this.dragging) {
            this.dragging.onDrag?.(x, y);
            this.dragging = null;
            return true;
        }
        const r = this.hit(x, y);
        if (r?.onClick) { r.onClick(); return true; }
        return false;
    }
}
