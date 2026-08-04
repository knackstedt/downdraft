// ============================================================================
// RenderPipeline — slot-based render pass orchestration
// Games register passes into named slots; the pipeline executes them in order.
// ============================================================================

import type { CameraState } from "./camera";

export type RenderPassSlot = string;

export interface RenderContext {
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  passEncoder: GPURenderPassEncoder;
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
