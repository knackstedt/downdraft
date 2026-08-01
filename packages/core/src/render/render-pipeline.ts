// ============================================================================
// RenderPipeline — slot-based render pass orchestration
// Games register passes into named slots; the pipeline executes them in order.
// ============================================================================

import type { CameraState } from "./camera.ts";

export type RenderPassSlot =
  | "sky"
  | "terrain"
  | "entities"
  | "clouds"
  | "water"
  | "debug"
  | "models"
  | "holo"
  | "particles"
  | "gizmo"
  | "underwater-fog"
  | "custom";

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

const SLOT_ORDER: RenderPassSlot[] = [
  "sky",
  "terrain",
  "entities",
  "clouds",
  "water",
  "debug",
  "models",
  "holo",
  "particles",
  "gizmo",
  "underwater-fog",
  "custom",
];

const SLOT_INDEX: Record<string, number> = {};
SLOT_ORDER.forEach((s, i) => { SLOT_INDEX[s] = i; });

export class RenderPipeline {
  private entries: RenderPassEntry[] = [];
  private sorted: RenderPassEntry[] = [];
  private dirty = true;

  registerPass(slot: RenderPassSlot, name: string, render: (ctx: RenderContext) => void): void {
    this.entries.push({ slot, name, render, order: SLOT_INDEX[slot] ?? SLOT_ORDER.length });
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
