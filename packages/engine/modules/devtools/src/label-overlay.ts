// ============================================================================
// LabelOverlay — HTML-based billboard labels for dev mode
// Generic DOM management + projection; game provides labels via ILabelProvider.
// ============================================================================

import { calculateViewProj } from "@downdraft/engine";
import type { ILabelProvider } from "./types";

interface LabelEntry {
  el: HTMLDivElement;
}

const MAX_LABELS = 512;

export class LabelOverlay {
  private container: HTMLDivElement;
  private labels: Map<string, LabelEntry> = new Map();
  private active = false;
  private canvas: HTMLCanvasElement;
  private provider: ILabelProvider | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.container = document.createElement("div");
    this.container.className = "label-overlay";
    this.container.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      overflow: hidden;
      z-index: 0;
      display: none;
    `;
    const parent = canvas.parentElement;
    if (parent) {
      parent.style.position = parent.style.position || "relative";
      parent.appendChild(this.container);
    } else {
      document.body.appendChild(this.container);
    }
  }

  setProvider(provider: ILabelProvider): void {
    this.provider = provider;
  }

  setActive(active: boolean): void {
    this.active = active;
    this.container.style.display = active ? "block" : "none";
    if (!active) {
      this.clearLabels();
    }
  }

  isActive(): boolean {
    return this.active;
  }

  private clearLabels(): void {
    for (const entry of this.labels.values()) {
      entry.el.remove();
    }
    this.labels.clear();
  }

  private getOrCreateLabel(key: string): HTMLDivElement | null {
    let entry = this.labels.get(key);
    if (entry) return entry.el;

    if (this.labels.size >= MAX_LABELS) return null;

    const el = document.createElement("div");
    el.className = "dev-label";
    el.style.cssText = `
      position: absolute;
      font-family: monospace;
      font-size: 11px;
      color: #fff;
      background: rgba(0, 0, 0, 0.65);
      border-radius: 3px;
      padding: 1px 5px;
      white-space: nowrap;
      pointer-events: none;
      transform: translate(-50%, -100%);
      will-change: transform, left, top;
      border: 1px solid rgba(255, 255, 255, 0.15);
    `;
    this.container.appendChild(el);
    this.labels.set(key, { el });
    return el;
  }

  private projectToScreen(
    worldX: number, worldY: number, worldZ: number,
    viewProj: Float32Array,
    canvasW: number, canvasH: number,
  ): { x: number; y: number; behind: boolean } | null {
    const x = viewProj[0] * worldX + viewProj[4] * worldY + viewProj[8] * worldZ + viewProj[12];
    const y = viewProj[1] * worldX + viewProj[5] * worldY + viewProj[9] * worldZ + viewProj[13];
    const w = viewProj[3] * worldX + viewProj[7] * worldY + viewProj[11] * worldZ + viewProj[15];

    if (w <= 0) return { x: 0, y: 0, behind: true };

    const ndcX = x / w;
    const ndcY = y / w;

    const screenX = (ndcX + 1) * 0.5 * canvasW;
    const screenY = (1 - ndcY) * 0.5 * canvasH;

    return { x: screenX, y: screenY, behind: false };
  }

  update(camera: Parameters<typeof calculateViewProj>[0]): void {
    if (!this.active || !this.provider) return;

    const viewProj = calculateViewProj(camera);
    const canvasW = this.canvas.clientWidth;
    const canvasH = this.canvas.clientHeight;

    const labels = this.provider.getLabels();
    const usedKeys = new Set<string>();

    for (const label of labels) {
      usedKeys.add(label.key);
      const proj = this.projectToScreen(label.x, label.y, label.z, viewProj, canvasW, canvasH);
      if (!proj || proj.behind) continue;

      const el = this.getOrCreateLabel(label.key);
      if (!el) continue;

      el.textContent = label.text;
      el.style.left = `${proj.x}px`;
      el.style.top = `${proj.y}px`;
      el.style.color = label.color;
      el.style.display = "block";
    }

    for (const [key, entry] of this.labels) {
      if (!usedKeys.has(key)) {
        entry.el.style.display = "none";
      }
    }
  }

  destroy(): void {
    this.clearLabels();
    this.container.remove();
  }
}
