// ============================================================================
// PaintCanvas — a raster bitmap that can be painted on and uploaded to GPU.
// Each paintable surface (prop, ground, avatar) gets its own PaintCanvas.
// ============================================================================

export interface PaintBrushSettings {
  color: [number, number, number, number]; // RGBA 0-1
  size: number; // brush radius in pixels
  hardness: number; // 0-1, edge softness
}

export class PaintCanvas {
  private width: number;
  private height: number;
  private data: Uint8ClampedArray; // RGBA
  private dirty = false;
  private dirtyRegions: Array<{ x: number; y: number; w: number; h: number }> = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    // Start transparent so unpainted areas keep the prop's base color.
    // The shaders use paint.a as the blend mask, so an opaque fill would
    // wash the whole surface white on the first upload.
    this.data.fill(0);
  }

  get Width(): number { return this.width; }
  get Height(): number { return this.height; }
  getData(): Uint8ClampedArray { return this.data; }
  isDirty(): boolean { return this.dirty; }

  /** Paint a circle at (x, y) with the given brush settings.
   *  Optional clip region restricts painting to a sub-rectangle (for atlas cells). */
  paint(x: number, y: number, brush: PaintBrushSettings, clip?: { x: number; y: number; w: number; h: number }): void {
    const r = brush.size;
    const r2 = r * r;
    const minX = Math.max(clip ? clip.x : 0, Math.floor(x - r));
    const maxX = Math.min(clip ? clip.x + clip.w - 1 : this.width - 1, Math.ceil(x + r));
    const minY = Math.max(clip ? clip.y : 0, Math.floor(y - r));
    const maxY = Math.min(clip ? clip.y + clip.h - 1 : this.height - 1, Math.ceil(y + r));

    const [cr, cg, cb, ca] = brush.color;

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const dx = px - x;
        const dy = py - y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > r2) continue;

        const dist = Math.sqrt(dist2);
        const t = dist / r;
        // Hardness controls how soft the edge is
        const alpha = t > brush.hardness
          ? ca * (1 - (t - brush.hardness) / (1 - brush.hardness))
          : ca;

        const idx = (py * this.width + px) * 4;
        // Alpha blend
        const dstA = this.data[idx + 3] / 255;
        const outA = alpha + dstA * (1 - alpha);
        if (outA > 0) {
          this.data[idx] = (cr * alpha + this.data[idx] * dstA * (1 - alpha)) / outA;
          this.data[idx + 1] = (cg * alpha + this.data[idx + 1] * dstA * (1 - alpha)) / outA;
          this.data[idx + 2] = (cb * alpha + this.data[idx + 2] * dstA * (1 - alpha)) / outA;
          this.data[idx + 3] = outA * 255;
        }
      }
    }

    this.dirty = true;
    this.dirtyRegions.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }

  /** Clear the canvas to a solid color (transparent by default). */
  clear(r: number = 0, g: number = 0, b: number = 0, a: number = 0): void {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = a;
    }
    this.dirty = true;
    this.dirtyRegions.push({ x: 0, y: 0, w: this.width, h: this.height });
  }

  /** Get and clear dirty regions. */
  consumeDirtyRegions(): Array<{ x: number; y: number; w: number; h: number }> {
    const regions = this.dirtyRegions;
    this.dirtyRegions = [];
    this.dirty = false;
    return regions;
  }

  /** Convert to ImageData for canvas operations. */
  toImageData(): ImageData {
    return new ImageData(new Uint8ClampedArray(this.data), this.width, this.height);
  }
}

// ── UV recovery + ray intersection ──

/**
 * Which face of a unit cube was hit. Used for per-face UV mapping into the
 * paint texture atlas (4×4 grid; each face gets its own 128×128 cell on a
 * 512×512 texture).
 */
export type CubeFace = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

// 4×4 atlas: each cell is 1/4 of the texture in each dimension.
const ATLAS_CELL_W = 0.25;
const ATLAS_CELL_H = 0.25;
// Half-texel inset to prevent linear filtering from bleeding across cells.
// Paint texture is 512×512, so half a texel = 0.5/512.
const HT = 0.5 / 512;

// Face → atlas cell origin (col, row) in UV space.
const FACE_ATLAS_OFFSET: Record<CubeFace, [number, number]> = {
  "+X": [0,            0],
  "-X": [ATLAS_CELL_W, 0],
  "+Y": [ATLAS_CELL_W * 2, 0],
  "-Y": [0,              ATLAS_CELL_H],
  "+Z": [ATLAS_CELL_W,   ATLAS_CELL_H],
  "-Z": [ATLAS_CELL_W * 2, ATLAS_CELL_H],
};

/**
 * Per-face UV formulas derived from the cube vertex data.
 * Each face maps the hit point's local coordinates to [0,1]² within the face,
 * then the atlas offset is applied so the UV lands in the correct cell.
 *
 * @param localPoint Hit point in the prop's local space (unit cube, half-extent 0.5)
 * @param face       Which face was hit (from rayBoxIntersect)
 * @returns UV coordinates [u, v] in the paint texture's atlas
 */
export function cubeFaceUV(localPoint: [number, number, number], face: CubeFace): [number, number] {
  // Clamp to box bounds to prevent floating-point overshoot from pushing
  // UVs into an adjacent atlas cell (edge bleed).
  const x = Math.max(-0.5, Math.min(0.5, localPoint[0]));
  const y = Math.max(-0.5, Math.min(0.5, localPoint[1]));
  const z = Math.max(-0.5, Math.min(0.5, localPoint[2]));
  // Face-local UV [0,1]² — derived from the vertex UV layout.
  let u: number, v: number;
  switch (face) {
    case "+X": u = z + 0.5;   v = y + 0.5;   break;
    case "-X": u = 0.5 - z;   v = y + 0.5;   break;
    case "+Y": u = x + 0.5;   v = z + 0.5;   break;
    case "-Y": u = x + 0.5;   v = 0.5 - z;   break;
    case "+Z": u = y + 0.5;   v = x + 0.5;   break;
    case "-Z": u = y + 0.5;   v = 0.5 - x;   break;
  }
  // Map into the atlas cell, inset by half a texel to match the vertex UVs.
  const [ox, oy] = FACE_ATLAS_OFFSET[face];
  return [ox + HT + u * (ATLAS_CELL_W - 2 * HT), oy + HT + v * (ATLAS_CELL_H - 2 * HT)];
}

/**
 * Returns the pixel-space clip rectangle for a cube face's atlas cell.
 * Use as the `clip` parameter to PaintCanvas.paint() to prevent brush
 * strokes from bleeding into adjacent atlas cells.
 */
export function cubeFacePixelBounds(face: CubeFace, canvasWidth: number, canvasHeight: number): { x: number; y: number; w: number; h: number } {
  const [ox, oy] = FACE_ATLAS_OFFSET[face];
  return {
    x: Math.floor((ox + HT) * canvasWidth),
    y: Math.floor((oy + HT) * canvasHeight),
    w: Math.floor((ATLAS_CELL_W - 2 * HT) * canvasWidth),
    h: Math.floor((ATLAS_CELL_H - 2 * HT) * canvasHeight),
  };
}

/**
 * Recover UV coordinates for the ground plane.
 * Maps world XZ to UV using a tiled pattern.
 *
 * @param worldX World X coordinate
 * @param worldZ World Z coordinate
 * @param tileSize Size of one texture tile in world units
 * @returns UV coordinates [u, v] in range [0, 1]
 */
export function groundPlaneUV(worldX: number, worldZ: number, tileSize: number = 4): [number, number] {
  return [
    (worldX / tileSize) % 1,
    (worldZ / tileSize) % 1,
  ];
}

/**
 * Convert a world-space point to a prop's local space (inverse TRS).
 */
export function worldToLocal(
  worldPoint: [number, number, number],
  propPosition: [number, number, number],
  propRotation: [number, number, number, number],
  propScale: number,
): [number, number, number] {
  // Translate
  const tx = worldPoint[0] - propPosition[0];
  const ty = worldPoint[1] - propPosition[1];
  const tz = worldPoint[2] - propPosition[2];

  // Inverse rotate (conjugate quaternion)
  const [qx, qy, qz, qw] = propRotation;
  const cx = -qx, cy = -qy, cz = -qz, cw = qw;

  const vx = tx, vy = ty, vz = tz;
  const tw = -cx * vx - cy * vy - cz * vz;
  const tx2 = cw * vx + cy * vz - cz * vy;
  const ty2 = cw * vy + cz * vx - cx * vz;
  const tz2 = cw * vz + cx * vy - cy * vx;

  const rx = tw * qx + tx2 * qw + ty2 * qz - tz2 * qy;
  const ry = tw * qy + ty2 * qw + tz2 * qx - tx2 * qz;
  const rz = tw * qz + tz2 * qw + tx2 * qy - ty2 * qx;

  const s = propScale !== 0 ? 1 / propScale : 1;
  return [rx * s, ry * s, rz * s];
}

/**
 * Transform a world-space direction vector to a prop's local space (inverse
 * rotation only — no translation or scale, since directions are
 * translation-invariant and we want the unit-cube intersection in local space).
 */
export function worldDirToLocalDir(
  worldDir: [number, number, number],
  propRotation: [number, number, number, number],
): [number, number, number] {
  const [qx, qy, qz, qw] = propRotation;
  const cx = -qx, cy = -qy, cz = -qz, cw = qw;

  const vx = worldDir[0], vy = worldDir[1], vz = worldDir[2];
  const tw = -cx * vx - cy * vy - cz * vz;
  const tx2 = cw * vx + cy * vz - cz * vy;
  const ty2 = cw * vy + cz * vx - cx * vz;
  const tz2 = cw * vz + cx * vy - cy * vx;

  const rx = tw * qx + tx2 * qw + ty2 * qz - tz2 * qy;
  const ry = tw * qy + ty2 * qw + tz2 * qx - tx2 * qz;
  const rz = tw * qz + tz2 * qw + tx2 * qy - ty2 * qx;

  return [rx, ry, rz];
}

export interface RayBoxHit {
  t: number;                          // ray parameter at the hit point
  face: CubeFace;                     // which face was hit
  localPoint: [number, number, number]; // hit point in local (unit-cube) space
}

/**
 * Ray-axis-aligned-box intersection via the slab method.
 * The box is centered at the origin with the given half-extent.
 *
 * @param origin    Ray origin in the box's local space
 * @param dir       Ray direction in the box's local space (need not be normalized)
 * @param halfExtent Half-extent of the box (default 0.5 = unit cube)
 * @returns Hit info or null if the ray misses / starts inside
 */
export function rayBoxIntersect(
  origin: [number, number, number],
  dir: [number, number, number],
  halfExtent: number = 0.5,
): RayBoxHit | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  let hitAxis = -1;
  let hitSign = 0;

  for (let i = 0; i < 3; i++) {
    const o = origin[i];
    const d = dir[i];
    const lo = -halfExtent;
    const hi = halfExtent;

    if (Math.abs(d) < 1e-10) {
      // Parallel to this axis — miss if outside the slab
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      let sign = -1; // entering through the lo plane → normal points -axis
      if (t1 > t2) {
        const tmp = t1; t1 = t2; t2 = tmp;
        sign = 1; // entering through the hi plane → normal points +axis
      }
      if (t1 > tmin) { tmin = t1; hitAxis = i; hitSign = sign; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }

  if (tmin < 0) return null; // box is behind the ray

  const faces: CubeFace[] = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];
  const faceIdx = hitAxis * 2 + (hitSign > 0 ? 0 : 1);
  const face = faces[faceIdx];

  const localPoint: [number, number, number] = [
    origin[0] + dir[0] * tmin,
    origin[1] + dir[1] * tmin,
    origin[2] + dir[2] * tmin,
  ];

  return { t: tmin, face, localPoint };
}

export interface RaySphereHit {
  t: number;
  localPoint: [number, number, number];
  normal: [number, number, number];
}

/**
 * Ray-sphere intersection. The sphere is centered at the origin with the
 * given radius. Returns the nearest hit in front of the ray.
 */
export function raySphereIntersect(
  origin: [number, number, number],
  dir: [number, number, number],
  radius: number,
): RaySphereHit | null {
  const dx = origin[0], dy = origin[1], dz = origin[2];
  const a = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
  const b = 2 * (dx * dir[0] + dy * dir[1] + dz * dir[2]);
  const c = dx * dx + dy * dy + dz * dz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  const t = t1 >= 0 ? t1 : t2;
  if (t < 0) return null;

  const localPoint: [number, number, number] = [
    dx + dir[0] * t,
    dy + dir[1] * t,
    dz + dir[2] * t,
  ];
  const nLen = Math.sqrt(localPoint[0] ** 2 + localPoint[1] ** 2 + localPoint[2] ** 2) || 1;
  const normal: [number, number, number] = [
    localPoint[0] / nLen,
    localPoint[1] / nLen,
    localPoint[2] / nLen,
  ];
  return { t, localPoint, normal };
}
