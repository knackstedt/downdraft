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
    // Fill with white
    this.data.fill(255);
  }

  get Width(): number { return this.width; }
  get Height(): number { return this.height; }
  getData(): Uint8ClampedArray { return this.data; }
  isDirty(): boolean { return this.dirty; }

  /** Paint a circle at (x, y) with the given brush settings. */
  paint(x: number, y: number, brush: PaintBrushSettings): void {
    const r = brush.size;
    const r2 = r * r;
    const minX = Math.max(0, Math.floor(x - r));
    const maxX = Math.min(this.width - 1, Math.ceil(x + r));
    const minY = Math.max(0, Math.floor(y - r));
    const maxY = Math.min(this.height - 1, Math.ceil(y + r));

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

  /** Clear the canvas to a solid color. */
  clear(r: number = 255, g: number = 255, b: number = 255, a: number = 255): void {
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

// ── UV recovery from raycast ──

/**
 * Recover UV coordinates from a raycast hit on a unit cube.
 * Uses the hit normal to determine which face was hit, then maps
 * the local position to UV coordinates [0,1]×[0,1].
 *
 * @param localPoint Hit point in the prop's local space (before transform)
 * @param normal Hit normal in local space
 * @returns UV coordinates [u, v] in range [0, 1]
 */
export function cubeFaceUV(localPoint: [number, number, number], normal: [number, number, number]): [number, number] {
  const absNx = Math.abs(normal[0]);
  const absNy = Math.abs(normal[1]);
  const absNz = Math.abs(normal[2]);

  // Determine which face is dominant
  if (absNx >= absNy && absNx >= absNz) {
    // +X or -X face: UV from (z, y)
    return [
      (localPoint[2] + 0.5),
      (localPoint[1] + 0.5),
    ];
  } else if (absNy >= absNx && absNy >= absNz) {
    // +Y or -Y face: UV from (x, z)
    return [
      (localPoint[0] + 0.5),
      (localPoint[2] + 0.5),
    ];
  } else {
    // +Z or -Z face: UV from (x, y)
    return [
      (localPoint[0] + 0.5),
      (localPoint[1] + 0.5),
    ];
  }
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
 * Convert a world-space hit point to a prop's local space.
 * @param worldPoint Hit point in world space
 * @param propPosition Prop position in world space
 * @param propRotation Prop rotation quaternion [x, y, z, w]
 * @param propScale Prop scale
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
  // Conjugate: [-qx, -qy, -qz, qw]
  const cx = -qx, cy = -qy, cz = -qz, cw = qw;

  // Rotate vector by conjugate quaternion
  // v' = q * v * q^-1, but for unit quaternions q^-1 = conjugate
  const vx = tx, vy = ty, vz = tz;
  // q * v (as quaternion product where v = (vx, vy, vz, 0))
  const tw = -cx * vx - cy * vy - cz * vz;
  const tx2 = cw * vx + cy * vz - cz * vy;
  const ty2 = cw * vy + cz * vx - cx * vz;
  const tz2 = cw * vz + cx * vy - cy * vx;

  // result * q^-1 (which is the original quaternion)
  const rx = tw * qx + tx2 * qw + ty2 * qz - tz2 * qy;
  const ry = tw * qy + ty2 * qw + tz2 * qx - tx2 * qz;
  const rz = tw * qz + tz2 * qw + tx2 * qy - ty2 * qx;

  // Inverse scale
  const s = propScale !== 0 ? 1 / propScale : 1;
  return [rx * s, ry * s, rz * s];
}
