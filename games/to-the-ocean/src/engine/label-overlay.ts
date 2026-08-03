// ============================================================================
// Label Overlay — HTML-based billboard labels for dev mode
// Projects 3D world positions to 2D screen space and positions DOM labels
// ============================================================================

import { calculateViewProj } from "@downdraft/core";
import { ENT, PLR, SimBufferReader } from "@shared/sim-buffer";
import { EntityType, EntityTypeNames } from "@shared/types";
import type { CameraState } from "./camera-system";

interface LabelEntry {
  el: HTMLDivElement;
}

const LABEL_COLORS: Record<number, string> = {
  [EntityType.Player]: "#4ec9b0",
  [EntityType.Ship]: "#569cd6",
  [EntityType.SmallCraft]: "#569cd6",
  [EntityType.Fish]: "#dcdcaa",
  [EntityType.Shark]: "#f44747",
  [EntityType.Eel]: "#ce9178",
  [EntityType.Jellyfish]: "#c586c0",
  [EntityType.DevilShrimp]: "#f44747",
  [EntityType.Whale]: "#9cdcfe",
  [EntityType.Dolphin]: "#9cdcfe",
  [EntityType.Turtle]: "#b5cea8",
  [EntityType.Crustacean]: "#dcdcaa",
  [EntityType.Coral]: "#c586c0",
  [EntityType.Moose]: "#dcdcaa",
  [EntityType.Pirate]: "#f44747",
  [EntityType.PirateShip]: "#f44747",
  [EntityType.Island]: "#b5cea8",
  [EntityType.Port]: "#dcdcaa",
  [EntityType.Reef]: "#c586c0",
  [EntityType.Wreck]: "#ce9178",
  [EntityType.Pet]: "#dcdcaa",
  [EntityType.Livestock]: "#b5cea8",
  [EntityType.Plant]: "#b5cea8",
  [EntityType.Placeable]: "#dcdcaa",
  [EntityType.RainCollector]: "#dcdcaa",
  [EntityType.Treasure]: "#dcdcaa",
};

const MAX_LABELS = 512;
const MAX_RENDER_DIST = 500;

export class LabelOverlay {
  private container: HTMLDivElement;
  private labels: Map<string, LabelEntry> = new Map();
  private active = false;
  private canvas: HTMLCanvasElement;

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
  ): { x: number; y: number; behind: boolean; dist: number } | null {
    const x = viewProj[0] * worldX + viewProj[4] * worldY + viewProj[8] * worldZ + viewProj[12];
    const y = viewProj[1] * worldX + viewProj[5] * worldY + viewProj[9] * worldZ + viewProj[13];
    const z = viewProj[2] * worldX + viewProj[6] * worldY + viewProj[10] * worldZ + viewProj[14];
    const w = viewProj[3] * worldX + viewProj[7] * worldY + viewProj[11] * worldZ + viewProj[15];

    if (w <= 0) return { x: 0, y: 0, behind: true, dist: 0 };

    const ndcX = x / w;
    const ndcY = y / w;
    const ndcZ = z / w;

    const screenX = (ndcX + 1) * 0.5 * canvasW;
    const screenY = (1 - ndcY) * 0.5 * canvasH;

    return { x: screenX, y: screenY, behind: false, dist: ndcZ };
  }

  update(
    camera: CameraState,
    simReader: SimBufferReader,
    viewport: { x: number; y: number; w: number; h: number },
  ): void {
    if (!this.active) return;
    if (!simReader.isValid()) return;

    const viewProj = calculateViewProj(camera);
    const canvasW = this.canvas.clientWidth;
    const canvasH = this.canvas.clientHeight;

    const entityCount = simReader.getEntityCount();
    const playerCount = simReader.getPlayerCount();

    // Use player position (slot 0) for distance calculations, not camera position
    const plrSlot0 = simReader.getPlayerSlot(0);
    const refX = plrSlot0 ? plrSlot0.f32[PLR.POS_X] : camera.position[0];
    const refY = plrSlot0 ? plrSlot0.f32[PLR.POS_Y] : camera.position[1];
    const refZ = plrSlot0 ? plrSlot0.f32[PLR.POS_Z] : camera.position[2];

    // Debug log once per second
    if (performance.now() - (this as any)._lastDebugLog > 1000) {
      (this as any)._lastDebugLog = performance.now();
      console.log(`[LabelOverlay] active=${this.active} entities=${entityCount} players=${playerCount} canvas=${canvasW}x${canvasH} container.display=${this.container.style.display} labels=${this.labels.size}`);
    }

    const usedKeys = new Set<string>();
    let labelIdx = 0;

    for (let i = 0; i < entityCount && labelIdx < MAX_LABELS; i++) {
      const entSlot = simReader.getEntitySlot(i);
      if (!entSlot) continue;
      const entId = entSlot.u32[ENT.ID];
      if (entId === 0) continue;
      const type = entSlot.u32[ENT.TYPE] as EntityType;

      const ex = entSlot.f32[ENT.POS_X];
      const ey = entSlot.f32[ENT.POS_Y];
      const ez = entSlot.f32[ENT.POS_Z];
      const scale = entSlot.f32[ENT.SCALE];

      const dx = ex - refX, dy = ey - refY, dz = ez - refZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > MAX_RENDER_DIST) continue;

      const key = `ent-${entId}`;
      usedKeys.add(key);

      const proj = this.projectToScreen(ex, ey + scale + 1, ez, viewProj, canvasW, canvasH);
      if (!proj || proj.behind) continue;

      const el = this.getOrCreateLabel(key);
      if (!el) continue;

      const typeName = EntityTypeNames[type] ?? `Type${type}`;
      const color = LABEL_COLORS[type] ?? "#dcdcaa";
      const distStr = dist < 100 ? dist.toFixed(0) : Math.round(dist / 10) * 10;
      el.textContent = `${typeName} #${entId} (${distStr}m)`;
      el.style.left = `${proj.x}px`;
      el.style.top = `${proj.y}px`;
      el.style.color = color;
      el.style.display = "block";
      labelIdx++;
    }

    for (let i = 0; i < playerCount && labelIdx < MAX_LABELS; i++) {
      const plrSlot = simReader.getPlayerSlot(i);
      if (!plrSlot) continue;
      const playerId = plrSlot.u32[PLR.PLAYER_ID];
      const entityId = plrSlot.u32[PLR.ENTITY_ID];
      if (playerId === 0) continue;

      const px = plrSlot.f32[PLR.POS_X];
      const py = plrSlot.f32[PLR.POS_Y];
      const pz = plrSlot.f32[PLR.POS_Z];

      const dx = px - refX, dy = py - refY, dz = pz - refZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > MAX_RENDER_DIST) continue;

      const key = `plr-${playerId}`;
      usedKeys.add(key);

      const proj = this.projectToScreen(px, py + 2.5, pz, viewProj, canvasW, canvasH);
      if (!proj || proj.behind) continue;

      const el = this.getOrCreateLabel(key);
      if (!el) continue;

      el.textContent = `Player #${playerId} (${Math.round(dist)}m)`;
      el.style.left = `${proj.x}px`;
      el.style.top = `${proj.y}px`;
      el.style.color = LABEL_COLORS[EntityType.Player] ?? "#4ec9b0";
      el.style.display = "block";
      labelIdx++;
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
