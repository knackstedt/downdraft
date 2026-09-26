// ============================================================================
// stack.ts — shared interface + helpers for the ui-bakeoff test bed.
//
// Each UI stack renders the SAME component gallery (tab bar, buttons,
// checkboxes, slider, progress bar, segmented control, scroll list, text
// field, HUD mock) so the stacks can be compared visually and ergonomically.
// ============================================================================

import { UiBlitPass } from "@downdraft/engine/libraries/pixi-ui-native";

export const TABS = ["imui", "PixiJS", "Dioxus", "HTML/CSS", "Canvas2D"] as const;

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
    private blitPass: UiBlitPass;
    private texture: GPUTexture | null = null;
    private texW = 0;
    private texH = 0;

    constructor(private device: GPUDevice, format: GPUTextureFormat) {
        this.blitPass = new UiBlitPass(device, format);
    }

    private ensure(w: number, h: number): GPUTexture | null {
        if (this.texture && this.texW === w && this.texH === h) return this.texture;
        this.texture?.destroy();
        this.texture = this.device.createTexture({
            size: { width: Math.max(1, w), height: Math.max(1, h) },
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
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
        const encoder = this.device.createCommandEncoder();
        this.blitPass.execute(encoder, target, this.texture.createView());
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
        for (const r of this.regions) {
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
