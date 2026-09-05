// ============================================================================
// @andrews-sandbox/module-paint — paint system controller.
// Manages PaintCanvas instances per prop, handles raycast → UV → paint,
// and uploads dirty textures to the GPU.
// ============================================================================

import {
    cubeFaceUV, groundPlaneUV,
    PaintCanvas,
    worldToLocal,
    type PaintBrushSettings,
} from "@andrews-sandbox/library-paint";
import { ENT, SimBufferReader } from "@downdraft/core";
import { EntityType } from "@sandbox/shared/types";

export interface PaintRendererApi {
  getCameraPosition(): [number, number, number];
  getCameraTarget(): [number, number, number];
  getDevice(): GPUDevice | null;
  /** Upload a paint texture for a prop entity. */
  uploadPaintTexture?(entityId: number, data: Uint8ClampedArray, width: number, height: number): void;
  /** Upload the ground paint texture. */
  uploadGroundPaintTexture?(data: Uint8ClampedArray, width: number, height: number): void;
}

export interface PaintSimApi {
  sendCommand(cmd: any): void;
}

export interface PaintSystemConfig {
  sim: PaintSimApi;
  renderer: PaintRendererApi;
  simSAB: SharedArrayBuffer;
  /** Max texture resolution for painting. Default 1024. */
  maxResolution?: number;
}

const DEFAULT_BRUSH: PaintBrushSettings = {
  color: [1, 0, 0, 1],
  size: 20,
  hardness: 0.8,
};

export class PaintSystem {
  private sim: PaintSimApi;
  private renderer: PaintRendererApi;
  private simSAB: SharedArrayBuffer;
  private maxRes: number;

  // Per-entity paint canvases
  private canvases = new Map<number, PaintCanvas>();
  // Ground plane canvas
  private groundCanvas: PaintCanvas;

  private brush: PaintBrushSettings = { ...DEFAULT_BRUSH };
  private firing = false;

  constructor(config: PaintSystemConfig) {
    this.sim = config.sim;
    this.renderer = config.renderer;
    this.simSAB = config.simSAB;
    this.maxRes = config.maxResolution ?? 1024;
    this.groundCanvas = new PaintCanvas(512, 512);
  }

  setBrushColor(r: number, g: number, b: number, a: number = 1): void {
    this.brush.color = [r, g, b, a];
  }

  setBrushColorHex(hex: string): void {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    this.setBrushColor(r, g, b);
  }

  setBrushSize(size: number): void {
    this.brush.size = size;
  }

  setBrushHardness(hardness: number): void {
    this.brush.hardness = hardness;
  }

  startFiring(): void { this.firing = true; }
  stopFiring(): void { this.firing = false; }

  isFiring(): boolean { return this.firing; }

  /** Get or create a paint canvas for an entity. */
  getCanvas(entityId: number): PaintCanvas {
    let canvas = this.canvases.get(entityId);
    if (!canvas) {
      canvas = new PaintCanvas(256, 256);
      this.canvases.set(entityId, canvas);
    }
    return canvas;
  }

  getGroundCanvas(): PaintCanvas {
    return this.groundCanvas;
  }

  /** Per-frame tick — if firing, raycast and paint. */
  tick(): void {
    if (!this.firing) return;

    const hit = this.raycastForPaint();
    if (!hit) return;

    if (hit.kind === "prop") {
      const canvas = this.getCanvas(hit.entityId!);
      const u = hit.uv[0];
      const v = hit.uv[1];
      const px = u * canvas.Width;
      const py = (1 - v) * canvas.Height; // flip Y for image coordinates
      canvas.paint(px, py, this.brush);

      // Upload to GPU
      this.renderer.uploadPaintTexture?.(hit.entityId!, canvas.getData(), canvas.Width, canvas.Height);
    } else if (hit.kind === "ground") {
      const canvas = this.groundCanvas;
      const px = hit.uv[0] * canvas.Width;
      const py = (1 - hit.uv[1]) * canvas.Height;
      canvas.paint(px, py, this.brush);
      // Upload to GPU
      this.renderer.uploadGroundPaintTexture?.(canvas.getData(), canvas.Width, canvas.Height);
    }
  }

  /** Raycast from camera center and compute UV for the hit surface. */
  private raycastForPaint(): PaintHit | null {
    const reader = new SimBufferReader(this.simSAB);
    const cam = this.renderer.getCameraPosition();
    const target = this.renderer.getCameraTarget();
    const dx = target[0] - cam[0];
    const dy = target[1] - cam[1];
    const dz = target[2] - cam[2];
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const dir: [number, number, number] = [dx / dl, dy / dl, dz / dl];

    // Check props first (closest hit)
    const count = reader.getEntityCount();
    let closestPropDist = Infinity;
    let closestPropSlot = -1;

    for (let i = 0; i < count; i++) {
      const slot = reader.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];
      if (type !== EntityType.Prop && type !== EntityType.Mannequin) continue;
      const px = slot.f32[ENT.POS_X];
      const py = slot.f32[ENT.POS_Y];
      const pz = slot.f32[ENT.POS_Z];
      const scale = slot.f32[ENT.SCALE] || 1.0;

      // Simple sphere intersection with radius = 0.5 * scale
      const ox = px - cam[0];
      const oy = py - cam[1];
      const oz = pz - cam[2];
      const proj = ox * dir[0] + oy * dir[1] + oz * dir[2];
      if (proj < 0 || proj >= closestPropDist) continue;
      const perpSq = ox * ox + oy * oy + oz * oz - proj * proj;
      const radius = 0.5 * scale;
      if (perpSq > radius * radius) continue;

      closestPropDist = proj;
      closestPropSlot = i;
    }

    // Check ground plane (y = 0)
    if (dir[1] !== 0) {
      const groundDist = -cam[1] / dir[1];
      if (groundDist > 0 && groundDist < closestPropDist) {
        const hitX = cam[0] + dir[0] * groundDist;
        const hitZ = cam[2] + dir[2] * groundDist;
        const uv = groundPlaneUV(hitX, hitZ);
        return { kind: "ground", uv, worldPoint: [hitX, 0, hitZ] };
      }
    }

    if (closestPropSlot >= 0) {
      const slot = reader.getEntitySlot(closestPropSlot);
      const px = slot.f32[ENT.POS_X];
      const py = slot.f32[ENT.POS_Y];
      const pz = slot.f32[ENT.POS_Z];
      const scale = slot.f32[ENT.SCALE] || 1.0;
      const rx = slot.f32[ENT.ROT_X];
      const ry = slot.f32[ENT.ROT_Y];
      const rz = slot.f32[ENT.ROT_Z];
      const rw = slot.f32[ENT.ROT_W];

      const worldPoint: [number, number, number] = [
        cam[0] + dir[0] * closestPropDist,
        cam[1] + dir[1] * closestPropDist,
        cam[2] + dir[2] * closestPropDist,
      ];

      // Convert to local space
      const localPoint = worldToLocal(worldPoint, [px, py, pz], [rx, ry, rz, rw], scale);

      // Approximate normal as the direction from prop center to hit point (in local space)
      const nLen = Math.sqrt(localPoint[0] ** 2 + localPoint[1] ** 2 + localPoint[2] ** 2) || 1;
      const normal: [number, number, number] = [
        localPoint[0] / nLen,
        localPoint[1] / nLen,
        localPoint[2] / nLen,
      ];

      // For cubes, use face-based UV
      const uv = cubeFaceUV(localPoint, normal);

      return {
        kind: "prop",
        entityId: closestPropSlot + 1,
        uv,
        worldPoint,
        localPoint,
        normal,
      };
    }

    return null;
  }
}

interface PaintHit {
  kind: "prop" | "ground";
  uv: [number, number];
  worldPoint: [number, number, number];
  localPoint?: [number, number, number];
  normal?: [number, number, number];
  entityId?: number;
}
