// ============================================================================
// DebugOverlay — 2D canvas overlay for chunk grid + velocity arrows
// Projects 3D world positions to screen space and draws debug visuals
// ============================================================================

import type { CameraState } from "./CameraSystem";
import { calculateViewProj } from "./mathUtils";
import { SimBufferReader, ENT, PLR } from "@shared/sim-buffer";
import { CHUNK_SIZE, CHUNKS_VISIBLE } from "@shared/constants";

export class DebugOverlay {
  private canvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private showChunkGrid = false;
  private showVelocityArrows = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.overlay = document.createElement("canvas");
    this.overlay.className = "debug-overlay";
    this.overlay.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 0;
      display: none;
    `;
    const parent = canvas.parentElement;
    if (parent) {
      parent.style.position = parent.style.position || "relative";
      parent.appendChild(this.overlay);
    } else {
      document.body.appendChild(this.overlay);
    }
    this.ctx = this.overlay.getContext("2d")!;
  }

  private syncSize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
  }

  setShowChunkGrid(show: boolean): void {
    this.showChunkGrid = show;
    this.updateDisplay();
  }

  setShowVelocityArrows(show: boolean): void {
    this.showVelocityArrows = show;
    this.updateDisplay();
  }

  isChunkGridVisible(): boolean {
    return this.showChunkGrid;
  }

  isVelocityArrowsVisible(): boolean {
    return this.showVelocityArrows;
  }

  private updateDisplay(): void {
    const active = this.showChunkGrid || this.showVelocityArrows;
    this.overlay.style.display = active ? "block" : "none";
    if (!active) {
      this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }
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

  update(
    camera: CameraState,
    simReader: SimBufferReader,
    viewport: { x: number; y: number; w: number; h: number },
  ): void {
    if (!this.showChunkGrid && !this.showVelocityArrows) return;
    if (!simReader.isValid()) return;

    this.syncSize();
    const ctx = this.ctx;
    const canvasW = this.overlay.width;
    const canvasH = this.overlay.height;
    ctx.clearRect(0, 0, canvasW, canvasH);

    const viewProj = calculateViewProj(camera);

    if (this.showChunkGrid) {
      this.renderChunkGrid(ctx, camera, viewProj, canvasW, canvasH, simReader);
    }

    if (this.showVelocityArrows) {
      this.renderVelocityArrows(ctx, viewProj, canvasW, canvasH, simReader);
    }
  }

  private renderChunkGrid(
    ctx: CanvasRenderingContext2D,
    camera: CameraState,
    viewProj: Float32Array,
    canvasW: number, canvasH: number,
    simReader: SimBufferReader,
  ): void {
    const playerSlot = simReader.getPlayerSlot(0);
    if (!playerSlot) return;
    const px = playerSlot.f32[PLR.POS_X];
    const pz = playerSlot.f32[PLR.POS_Z];

    const playerChunkX = Math.floor(px / CHUNK_SIZE);
    const playerChunkZ = Math.floor(pz / CHUNK_SIZE);
    const half = Math.ceil(CHUNKS_VISIBLE / 2);

    ctx.strokeStyle = "rgba(100, 200, 255, 0.35)";
    ctx.lineWidth = 1;
    ctx.font = "10px monospace";
    ctx.fillStyle = "rgba(100, 200, 255, 0.6)";

    for (let cx = playerChunkX - half; cx <= playerChunkX + half; cx++) {
      for (let cz = playerChunkZ - half; cz <= playerChunkZ + half; cz++) {
        const worldX = cx * CHUNK_SIZE;
        const worldZ = cz * CHUNK_SIZE;

        // Draw grid cell border at y=0 (sea level)
        const corners = [
          this.projectToScreen(worldX, 0, worldZ, viewProj, canvasW, canvasH),
          this.projectToScreen(worldX + CHUNK_SIZE, 0, worldZ, viewProj, canvasW, canvasH),
          this.projectToScreen(worldX + CHUNK_SIZE, 0, worldZ + CHUNK_SIZE, viewProj, canvasW, canvasH),
          this.projectToScreen(worldX, 0, worldZ + CHUNK_SIZE, viewProj, canvasW, canvasH),
        ];

        if (corners.some(c => c === null || c.behind)) continue;

        ctx.beginPath();
        ctx.moveTo(corners[0]!.x, corners[0]!.y);
        ctx.lineTo(corners[1]!.x, corners[1]!.y);
        ctx.lineTo(corners[2]!.x, corners[2]!.y);
        ctx.lineTo(corners[3]!.x, corners[3]!.y);
        ctx.closePath();
        ctx.stroke();

        // Label chunk coords at center
        const centerProj = this.projectToScreen(
          worldX + CHUNK_SIZE / 2, 0, worldZ + CHUNK_SIZE / 2,
          viewProj, canvasW, canvasH,
        );
        if (centerProj && !centerProj.behind) {
          const dx = (worldX + CHUNK_SIZE / 2) - camera.position[0];
          const dz = (worldZ + CHUNK_SIZE / 2) - camera.position[2];
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < CHUNK_SIZE * half) {
            ctx.fillText(`${cx},${cz}`, centerProj.x - 15, centerProj.y);
          }
        }
      }
    }
  }

  private renderVelocityArrows(
    ctx: CanvasRenderingContext2D,
    viewProj: Float32Array,
    canvasW: number, canvasH: number,
    simReader: SimBufferReader,
  ): void {
    const entityCount = simReader.getEntityCount();

    ctx.strokeStyle = "rgba(255, 200, 50, 0.8)";
    ctx.fillStyle = "rgba(255, 200, 50, 0.8)";
    ctx.lineWidth = 2;

    for (let i = 0; i < entityCount; i++) {
      const slot = simReader.getEntitySlot(i);
      if (!slot) continue;
      const vx = slot.f32[ENT.VEL_X];
      const vy = slot.f32[ENT.VEL_Y];
      const vz = slot.f32[ENT.VEL_Z];
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed < 0.1) continue;

      const ex = slot.f32[ENT.POS_X];
      const ey = slot.f32[ENT.POS_Y];
      const ez = slot.f32[ENT.POS_Z];

      // Arrow start = entity position, end = position + velocity * scale
      const scale = 2.0;
      const endX = ex + vx * scale;
      const endY = ey + vy * scale;
      const endZ = ez + vz * scale;

      const startProj = this.projectToScreen(ex, ey, ez, viewProj, canvasW, canvasH);
      const endProj = this.projectToScreen(endX, endY, endZ, viewProj, canvasW, canvasH);

      if (!startProj || startProj.behind || !endProj || endProj.behind) continue;

      // Draw line
      ctx.beginPath();
      ctx.moveTo(startProj.x, startProj.y);
      ctx.lineTo(endProj.x, endProj.y);
      ctx.stroke();

      // Draw arrowhead
      const dx = endProj.x - startProj.x;
      const dy = endProj.y - startProj.y;
      const angle = Math.atan2(dy, dx);
      const headLen = 6;
      ctx.beginPath();
      ctx.moveTo(endProj.x, endProj.y);
      ctx.lineTo(
        endProj.x - headLen * Math.cos(angle - Math.PI / 6),
        endProj.y - headLen * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(
        endProj.x - headLen * Math.cos(angle + Math.PI / 6),
        endProj.y - headLen * Math.sin(angle + Math.PI / 6),
      );
      ctx.closePath();
      ctx.fill();

      // Speed label
      ctx.font = "10px monospace";
      ctx.fillText(`${speed.toFixed(1)} m/s`, endProj.x + 4, endProj.y - 4);
    }
  }

  destroy(): void {
    this.overlay.remove();
  }
}
