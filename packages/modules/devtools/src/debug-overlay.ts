// ============================================================================
// DebugOverlay — 2D canvas overlay for chunk grid + velocity arrows
// Generic rendering logic; game provides data via IDebugOverlayData interface.
// ============================================================================

import { calculateViewProj, CanvasResizeWatcher } from "@downdraft/core";
import type { IDebugOverlayData } from "./types";

export class DebugOverlay {
  private canvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private showChunkGrid = false;
  private showVelocityArrows = false;
  private resizeWatcher: CanvasResizeWatcher;

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
    this.resizeWatcher = new CanvasResizeWatcher(canvas, {
      onResize: (w, h) => {
        if (this.overlay.width !== w || this.overlay.height !== h) {
          this.overlay.width = w;
          this.overlay.height = h;
        }
      },
    });
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
    camera: Parameters<typeof calculateViewProj>[0],
    data: IDebugOverlayData,
  ): void {
    if (!this.showChunkGrid && !this.showVelocityArrows) return;

    const ctx = this.ctx;
    const canvasW = this.overlay.width;
    const canvasH = this.overlay.height;
    ctx.clearRect(0, 0, canvasW, canvasH);

    const viewProj = calculateViewProj(camera);

    if (this.showChunkGrid) {
      this.renderChunkGrid(ctx, camera, viewProj, canvasW, canvasH, data);
    }

    if (this.showVelocityArrows) {
      this.renderVelocityArrows(ctx, viewProj, canvasW, canvasH, data);
    }
  }

  private renderChunkGrid(
    ctx: CanvasRenderingContext2D,
    camera: { position: [number, number, number] },
    viewProj: Float32Array,
    canvasW: number, canvasH: number,
    data: IDebugOverlayData,
  ): void {
    const playerPos = data.getPlayerPosition();
    if (!playerPos) return;
    const { chunkSize, chunksVisible } = data.getChunkGridConfig();

    const playerChunkX = Math.floor(playerPos.x / chunkSize);
    const playerChunkZ = Math.floor(playerPos.z / chunkSize);
    const half = Math.ceil(chunksVisible / 2);

    ctx.strokeStyle = "rgba(100, 200, 255, 0.35)";
    ctx.lineWidth = 1;
    ctx.font = "10px monospace";
    ctx.fillStyle = "rgba(100, 200, 255, 0.6)";

    for (let cx = playerChunkX - half; cx <= playerChunkX + half; cx++) {
      for (let cz = playerChunkZ - half; cz <= playerChunkZ + half; cz++) {
        const worldX = cx * chunkSize;
        const worldZ = cz * chunkSize;

        const corners = [
          this.projectToScreen(worldX, 0, worldZ, viewProj, canvasW, canvasH),
          this.projectToScreen(worldX + chunkSize, 0, worldZ, viewProj, canvasW, canvasH),
          this.projectToScreen(worldX + chunkSize, 0, worldZ + chunkSize, viewProj, canvasW, canvasH),
          this.projectToScreen(worldX, 0, worldZ + chunkSize, viewProj, canvasW, canvasH),
        ];

        if (corners.some(c => c === null || c.behind)) continue;

        ctx.beginPath();
        ctx.moveTo(corners[0]!.x, corners[0]!.y);
        ctx.lineTo(corners[1]!.x, corners[1]!.y);
        ctx.lineTo(corners[2]!.x, corners[2]!.y);
        ctx.lineTo(corners[3]!.x, corners[3]!.y);
        ctx.closePath();
        ctx.stroke();

        const centerProj = this.projectToScreen(
          worldX + chunkSize / 2, 0, worldZ + chunkSize / 2,
          viewProj, canvasW, canvasH,
        );
        if (centerProj && !centerProj.behind) {
          const dx = (worldX + chunkSize / 2) - camera.position[0];
          const dz = (worldZ + chunkSize / 2) - camera.position[2];
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < chunkSize * half) {
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
    data: IDebugOverlayData,
  ): void {
    const entityCount = data.getEntityCount();

    ctx.strokeStyle = "rgba(255, 200, 50, 0.8)";
    ctx.fillStyle = "rgba(255, 200, 50, 0.8)";
    ctx.lineWidth = 2;

    for (let i = 0; i < entityCount; i++) {
      const pos = data.getEntityPosition(i);
      const vel = data.getEntityVelocity(i);
      if (!pos || !vel) continue;

      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
      if (speed < 0.1) continue;

      const scale = 2.0;
      const endX = pos.x + vel.x * scale;
      const endY = pos.y + vel.y * scale;
      const endZ = pos.z + vel.z * scale;

      const startProj = this.projectToScreen(pos.x, pos.y, pos.z, viewProj, canvasW, canvasH);
      const endProj = this.projectToScreen(endX, endY, endZ, viewProj, canvasW, canvasH);

      if (!startProj || startProj.behind || !endProj || endProj.behind) continue;

      ctx.beginPath();
      ctx.moveTo(startProj.x, startProj.y);
      ctx.lineTo(endProj.x, endProj.y);
      ctx.stroke();

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

      ctx.font = "10px monospace";
      ctx.fillText(`${speed.toFixed(1)} m/s`, endProj.x + 4, endProj.y - 4);
    }
  }

  destroy(): void {
    this.resizeWatcher.destroy();
    this.overlay.remove();
  }
}
