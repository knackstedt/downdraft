// ============================================================================
// @andrews-sandbox/module-paint — paint system controller.
// Manages PaintCanvas instances per prop, handles raycast → UV → paint,
// and uploads dirty textures to the GPU.
// ============================================================================

import {
    cubeFacePixelBounds,
    cubeFaceUV,
    groundPlaneUV,
    PaintCanvas,
    rayBoxIntersect,
    raySphereIntersect,
    worldDirToLocalDir,
    worldToLocal,
    type CubeFace,
    type PaintBrushSettings
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
      canvas = new PaintCanvas(512, 512);
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
      // UV → pixel: no V flip. In WebGPU, UV (0,0) samples the first texel
      // (top-left of the uploaded data), and V increases downward. The
      // cubeFaceUV() returns UVs in the same convention as the vertex UVs,
      // so mapping UV directly to pixel coordinates lands the stroke in the
      // correct atlas cell and at the correct position on the face.
      const px = hit.uv[0] * canvas.Width;
      const py = hit.uv[1] * canvas.Height;
      // For cube faces, clip the brush to the atlas cell so strokes near
      // edges don't bleed into the adjacent face's cell.
      const clip = hit.face ? cubeFacePixelBounds(hit.face, canvas.Width, canvas.Height) : undefined;
      canvas.paint(px, py, this.brush, clip);

      // Upload to GPU
      this.renderer.uploadPaintTexture?.(hit.entityId!, canvas.getData(), canvas.Width, canvas.Height);
    } else if (hit.kind === "ground") {
      const canvas = this.groundCanvas;
      const px = hit.uv[0] * canvas.Width;
      const py = hit.uv[1] * canvas.Height;
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

    // Check props — transform the ray into each prop's local space and do
    // a proper box (cube) or sphere intersection. This gives accurate hit
    // points and correct per-face UVs for cubes.
    const count = reader.getEntityCount();
    let bestT = Infinity;
    let bestHit: PaintHit | null = null;

    for (let i = 0; i < count; i++) {
      const slot = reader.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];
      if (type === 255 || (type !== EntityType.Prop && type !== EntityType.Mannequin)) continue;
      // Skip model-based props — paint textures are only applied to builtin
      // cubes/spheres (nodeId === 0). Model props are rendered by
      // ModelRenderer which doesn't support the paint texture binding.
      if (slot.u32[ENT.ID] !== 0) continue;
      const px = slot.f32[ENT.POS_X];
      const py = slot.f32[ENT.POS_Y];
      const pz = slot.f32[ENT.POS_Z];
      const scale = slot.f32[ENT.SCALE] || 1.0;
      const rx = slot.f32[ENT.ROT_X];
      const ry = slot.f32[ENT.ROT_Y];
      const rz = slot.f32[ENT.ROT_Z];
      const rw = slot.f32[ENT.ROT_W];
      const shape = slot.f32[5 + ENT.DATA]; // ENT_DATA.SHAPE=5; 0 = box, 1 = sphere

      // Transform ray origin + direction into the prop's local space.
      // The unit cube/sphere has half-extent 0.5, so we divide by scale.
      const localOrigin: [number, number, number] = worldToLocal(
        cam, [px, py, pz], [rx, ry, rz, rw], scale,
      );
      const localDir: [number, number, number] = worldDirToLocalDir(
        dir, [rx, ry, rz, rw],
      );

      const entityId = i + 1;

      // The local-space intersection returns t in local units. Since
      // worldToLocal divides the origin by scale but worldDirToLocalDir
      // does not scale the direction, the world-space distance is
      // t_local * scale (localDir is unit-length because rotation preserves
      // length and dir is normalized).
      if (shape === 1) {
        // Sphere — ray-sphere intersection with radius 0.5
        const hit = raySphereIntersect(localOrigin, localDir, 0.5);
        if (!hit) continue;
        const tWorld = hit.t * scale;
        if (tWorld >= bestT) continue;
        bestT = tWorld;
        // UV: map the local hit point on the sphere to UV using a simple
        // spherical projection (same for all sphere props — they share one
        // UV space since the sphere mesh uses standard UVs).
        const u = 0.5 + Math.atan2(hit.normal[2], hit.normal[0]) / (2 * Math.PI);
        const v = 0.5 - Math.asin(hit.normal[1]) / Math.PI;
        const worldPoint: [number, number, number] = [
          cam[0] + dir[0] * tWorld,
          cam[1] + dir[1] * tWorld,
          cam[2] + dir[2] * tWorld,
        ];
        bestHit = {
          kind: "prop",
          entityId,
          uv: [u, v],
          worldPoint,
          localPoint: hit.localPoint,
          normal: hit.normal,
        };
      } else {
        // Cube — ray-box intersection with half-extent 0.5
        const hit = rayBoxIntersect(localOrigin, localDir, 0.5);
        if (!hit) continue;
        const tWorld = hit.t * scale;
        if (tWorld >= bestT) continue;
        bestT = tWorld;
        const uv = cubeFaceUV(hit.localPoint, hit.face);
        const worldPoint: [number, number, number] = [
          cam[0] + dir[0] * tWorld,
          cam[1] + dir[1] * tWorld,
          cam[2] + dir[2] * tWorld,
        ];
        const normal = faceNormal(hit.face);
        bestHit = {
          kind: "prop",
          entityId,
          uv,
          worldPoint,
          localPoint: hit.localPoint,
          normal,
          face: hit.face,
        };
      }
    }

    // Check ground plane (y = 0) — only if no prop was hit closer
    if (dir[1] !== 0) {
      const groundDist = -cam[1] / dir[1];
      if (groundDist > 0 && groundDist < bestT) {
        const hitX = cam[0] + dir[0] * groundDist;
        const hitZ = cam[2] + dir[2] * groundDist;
        const uv = groundPlaneUV(hitX, hitZ);
        return { kind: "ground", uv, worldPoint: [hitX, 0, hitZ] };
      }
    }

    return bestHit;
  }
}

function faceNormal(face: CubeFace): [number, number, number] {
  switch (face) {
    case "+X": return [1, 0, 0];
    case "-X": return [-1, 0, 0];
    case "+Y": return [0, 1, 0];
    case "-Y": return [0, -1, 0];
    case "+Z": return [0, 0, 1];
    case "-Z": return [0, 0, -1];
  }
}

interface PaintHit {
  kind: "prop" | "ground";
  uv: [number, number];
  worldPoint: [number, number, number];
  localPoint?: [number, number, number];
  normal?: [number, number, number];
  entityId?: number;
  face?: CubeFace;
}
