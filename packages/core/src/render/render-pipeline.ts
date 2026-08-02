// ============================================================================
// RenderPipeline — slot-based render pass orchestration
// Games register passes into named slots; the pipeline executes them in order.
// ============================================================================

import type { RenderBackend } from "./backend/render-backend.ts";
import type {
    BackendCommandEncoder,
    BackendRenderPassEncoder,
    BackendTextureView,
    TextureFormat,
} from "./backend/types.ts";
import type { CameraState } from "./camera.ts";

export type RenderPassSlot = string;

export interface RenderContext {
  /** The backend-agnostic render backend (always available). */
  backend: RenderBackend;
  /** Backend-agnostic command encoder (always available). */
  backendEncoder: BackendCommandEncoder;
  /** Backend-agnostic render pass encoder (always available). */
  backendPassEncoder: BackendRenderPassEncoder;
  /** Surface texture view for the current frame (always available). */
  surfaceView: BackendTextureView;
  /** Depth texture view for the current viewport (always available). */
  depthView: BackendTextureView;
  /** Surface texture format (backend-agnostic). */
  surfaceFormat: TextureFormat;
  /** Depth texture format (backend-agnostic). */
  depthFormat: TextureFormat;

  // ─── Native WebGPU access (deprecated — use backend fields for new code) ──
  /** Native WebGPU device. Only available when using WebGPU backend. */
  device: GPUDevice | null;
  /** Native WebGPU command encoder. Only available when using WebGPU backend. */
  encoder: GPUCommandEncoder | null;
  /** Native WebGPU render pass encoder. Only available when using WebGPU backend. */
  passEncoder: GPURenderPassEncoder | null;

  camera: CameraState;
  viewport: { x: number; y: number; w: number; h: number };
  viewportIdx: number;
  viewportCount: number;
  dt: number;
  elapsedTime: number;
  isFirstViewport: boolean;
  isLastViewport: boolean;
}

export interface RenderPassEntry {
  slot: RenderPassSlot;
  name: string;
  render: (ctx: RenderContext) => void;
  order: number;
}

export class RenderPipeline {
  private entries: RenderPassEntry[] = [];
  private sorted: RenderPassEntry[] = [];
  private dirty = true;
  private slotOrder: string[] = [];
  private slotIndex: Record<string, number> = {};

  /** Games define their slot order by passing an ordered list of slot names. */
  setSlotOrder(slots: string[]): void {
    this.slotOrder = [...slots];
    this.slotIndex = {};
    this.slotOrder.forEach((s, i) => { this.slotIndex[s] = i; });
    // Re-sort existing entries
    this.dirty = true;
  }

  registerPass(slot: RenderPassSlot, name: string, render: (ctx: RenderContext) => void): void {
    this.entries.push({ slot, name, render, order: this.slotIndex[slot] ?? this.slotOrder.length });
    this.dirty = true;
  }

  unregisterPass(name: string): void {
    this.entries = this.entries.filter(e => e.name !== name);
    this.dirty = true;
  }

  clear(): void {
    this.entries = [];
    this.dirty = true;
  }

  getEntries(): readonly RenderPassEntry[] {
    if (this.dirty) {
      this.sorted = [...this.entries].sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return 0;
      });
      this.dirty = false;
    }
    return this.sorted;
  }

  render(ctx: RenderContext): void {
    const entries = this.getEntries();
    for (let i = 0; i < entries.length; i++) {
      entries[i].render(ctx);
    }
  }
}
