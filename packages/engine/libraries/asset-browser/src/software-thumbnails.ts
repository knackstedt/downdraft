// ============================================================================
// SoftwareThumbnailRenderer — native counterpart to ThumbnailRenderer.
//
// The browser path rasterizes turntable thumbnails with a WebGL2
// OffscreenCanvas inside the pixi-ui worker. Native has no WebGL2, so this
// renderer rasterizes the same models on the CPU: positions + flat normals
// through a lookAt+perspective transform into a z-buffered Uint8Array, then
// putImageData into an OffscreenCanvas whose 2D context is the NativeCanvas2D
// shim. The scene composites it identically: ctx.drawImage(canvasElement).
//
// Shading mirrors THUMB_VS/THUMB_FS: two-sided lambert fill + subtle rim.
//
// `loadBytes` (optional) replaces fetch() for URI → bytes resolution, e.g.
// reading absolute filesystem paths through a game's IPC bridge on native.
// ============================================================================

import { loadModel, type ModelData } from "@downdraft/engine/libraries/models";

export interface SoftwareThumbnailOptions {
  /** Resolve a modelUri to bytes. Default: fetch(uri).arrayBuffer(). */
  loadBytes?: (uri: string) => Promise<ArrayBuffer>;
}

interface SoftModel {
  positions: Float32Array; // xyz per vertex
  indices: Uint16Array | Uint32Array;
  normals: Float32Array;   // flat normals, xyz per vertex
  center: [number, number, number];
  radius: number;
  baseColor: [number, number, number];
}

function computeFlatNormals(positions: Float32Array, indices: Uint16Array | Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    for (const j of [a, b, c]) {
      normals[j] += nx; normals[j + 1] += ny; normals[j + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const nl = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= nl; normals[i + 1] /= nl; normals[i + 2] /= nl;
  }
  return normals;
}

export class SoftwareThumbnailRenderer {
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private size: number;
  private pixels: Uint8ClampedArray;
  private depth: Float32Array;
  private loadBytes: (uri: string) => Promise<ArrayBuffer>;

  /** LRU cache: contentId → SoftModel. */
  private cache = new Map<string, SoftModel>();
  private loading = new Set<string>();
  private maxCache = 512;

  // Scratch transform buffers (reused per renderThumb call).
  private sx: Float32Array;
  private sy: Float32Array;
  private sz: Float32Array;
  private snx: Float32Array;
  private sny: Float32Array;
  private snz: Float32Array;

  constructor(size = 192, opts?: SoftwareThumbnailOptions) {
    this.size = size;
    this.canvas = new OffscreenCanvas(size, size);
    this.ctx = this.canvas.getContext("2d")!;
    this.pixels = new Uint8ClampedArray(size * size * 4);
    this.depth = new Float32Array(size * size);
    this.loadBytes = opts?.loadBytes ?? (async (uri) => {
      const resp = await fetch(uri);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.arrayBuffer();
    });
    const MAX_VERTS = 1 << 16;
    this.sx = new Float32Array(MAX_VERTS);
    this.sy = new Float32Array(MAX_VERTS);
    this.sz = new Float32Array(MAX_VERTS);
    this.snx = new Float32Array(MAX_VERTS);
    this.sny = new Float32Array(MAX_VERTS);
    this.snz = new Float32Array(MAX_VERTS);
  }

  get canvasElement(): OffscreenCanvas { return this.canvas; }

  has(contentId: string): boolean {
    return this.cache.has(contentId) || this.loading.has(contentId);
  }

  async loadModelThumb(modelUri: string, contentId: string): Promise<void> {
    if (this.cache.has(contentId) || this.loading.has(contentId)) return;
    this.loading.add(contentId);
    try {
      const buffer = await this.loadBytes(modelUri);
      const filename = modelUri.split("/").pop() ?? "model.glb";
      const model = await loadModel(buffer, filename) as ModelData;
      this.uploadModel(contentId, model);
    } catch (err) {
      console.warn(`[SoftwareThumbnailRenderer] Failed to load ${contentId} (${modelUri}):`, err);
      this.loadBuiltinCube(contentId);
    } finally {
      this.loading.delete(contentId);
    }
  }

  loadBuiltinCube(contentId: string): void {
    if (this.cache.has(contentId)) return;
    const positions = new Float32Array([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]);
    const indices = new Uint16Array([
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
      0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
      3, 2, 6, 3, 6, 7, 0, 4, 5, 0, 5, 1,
    ]);
    this.uploadGeometry(contentId, positions, indices, { center: [0, 0, 0], radius: Math.sqrt(3) / 2 });
  }

  loadBuiltinSphere(contentId: string): void {
    if (this.cache.has(contentId)) return;
    const lat = 12, lon = 16;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= lat; i++) {
      const theta = (i / lat) * Math.PI;
      const st = Math.sin(theta), ct = Math.cos(theta);
      for (let j = 0; j <= lon; j++) {
        const phi = (j / lon) * 2 * Math.PI;
        positions.push(st * Math.cos(phi) * 0.5, ct * 0.5, st * Math.sin(phi) * 0.5);
      }
    }
    for (let i = 0; i < lat; i++) {
      for (let j = 0; j < lon; j++) {
        const a = i * (lon + 1) + j, b = a + lon + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    this.uploadGeometry(contentId, new Float32Array(positions), new Uint16Array(indices), { center: [0, 0, 0], radius: 0.5 });
  }

  /**
   * Upload an already-parsed model — used when the game's own loader applies
   * accessory/variant filtering that raw loadModel() skips (unfiltered
   * player FBXs draw every variant superimposed).
   */
  uploadModelData(contentId: string, model: ModelData): void {
    this.uploadModel(contentId, model);
  }

  private uploadModel(contentId: string, model: ModelData): void {
    const meshes = model.meshes;
    if (!meshes || meshes.length === 0) { this.loadBuiltinCube(contentId); return; }
    let totalVerts = 0, totalIdx = 0;
    for (const m of meshes) { totalVerts += m.vertexCount; totalIdx += m.indexCount; }
    if (totalVerts > this.sx.length) {
      // Extremely large model — fall back to a cube rather than allocating
      // giant scratch buffers for a thumbnail.
      this.loadBuiltinCube(contentId);
      return;
    }
    const positions = new Float32Array(totalVerts * 3);
    const is32 = totalIdx > 65535;
    const indices = is32 ? new Uint32Array(totalIdx) : new Uint16Array(totalIdx);
    let vOff = 0, iOff = 0, vBase = 0;
    for (const m of meshes) {
      const stride = m.vertices.length / m.vertexCount;
      for (let v = 0; v < m.vertexCount; v++) {
        positions[vOff + v * 3] = m.vertices[v * stride];
        positions[vOff + v * 3 + 1] = m.vertices[v * stride + 1];
        positions[vOff + v * 3 + 2] = m.vertices[v * stride + 2];
      }
      vOff += m.vertexCount * 3;
      const src = m.indices;
      for (let i = 0; i < m.indexCount; i++) (indices as any)[iOff + i] = src[i] + vBase;
      iOff += m.indexCount;
      vBase += m.vertexCount;
    }
    let center: [number, number, number] = [0, 0, 0];
    let radius = 0.5;
    if (model.bounds) {
      const b = model.bounds;
      center = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      radius = Math.max(
        Math.hypot(b.max[0] - center[0], b.max[1] - center[1], b.max[2] - center[2]),
        Math.hypot(b.min[0] - center[0], b.min[1] - center[1], b.min[2] - center[2]),
      );
    } else {
      let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (positions[i + k] < min[k]) min[k] = positions[i + k];
          if (positions[i + k] > max[k]) max[k] = positions[i + k];
        }
      }
      center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      radius = Math.max(
        Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2]),
        Math.hypot(min[0] - center[0], min[1] - center[1], min[2] - center[2]),
      );
    }
    if (radius <= 0) radius = 0.5;
    let baseColor: [number, number, number] = [0.78, 0.82, 0.88];
    if (model.materials && model.materials.length > 0) {
      const mat = model.materials[0];
      baseColor = [mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]];
    }
    this.uploadGeometry(contentId, positions, indices, { center, radius }, baseColor);
  }

  private uploadGeometry(
    contentId: string,
    positions: Float32Array,
    indices: Uint16Array | Uint32Array,
    bounds: { center: [number, number, number]; radius: number },
    baseColor: [number, number, number] = [0.78, 0.82, 0.88],
  ): void {
    const normals = computeFlatNormals(positions, indices);
    if (this.cache.size >= this.maxCache) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(contentId, {
      positions, indices, normals,
      center: bounds.center, radius: bounds.radius, baseColor,
    });
  }

  /**
   * Rasterize one turntable frame for contentId into the canvas.
   * Returns false when the model isn't loaded yet.
   */
  renderThumb(contentId: string, angle: number): boolean {
    const m = this.cache.get(contentId);
    if (!m) return false;
    const size = this.size;
    const px = this.pixels;
    const depth = this.depth;

    // Clear to the same bg the WebGL version uses: rgba(0.16, 0.17, 0.22, 1).
    for (let i = 0; i < px.length; i += 4) {
      px[i] = 41; px[i + 1] = 43; px[i + 2] = 56; px[i + 3] = 255;
    }
    depth.fill(Infinity);

    // Camera: fixed position looking at the model center (matches renderThumb).
    const radius = Math.max(m.radius, 0.1);
    const dist = radius * 3.0;
    const ex = m.center[0];
    const ey = m.center[1] + m.radius * 0.4;
    const ez = m.center[2] + dist;
    const near = dist * 0.01;
    const far = dist * 10;

    // View basis (lookAt: eye→center, up +Y)
    let zx = ex - m.center[0], zy = ey - m.center[1], zz = ez - m.center[2];
    let zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
    // x = normalize(up × z) = normalize(zz, 0, -zx); y = z × x
    let xx = zz, xy = 0, xz = -zx;
    const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;

    const f = 1 / Math.tan((45 * Math.PI / 180) / 2);
    const nf = 1 / (near - far);
    const rotC = Math.cos(angle), rotS = Math.sin(angle);

    const vcount = m.positions.length / 3;
    const positions = m.positions, normals = m.normals;
    const sx = this.sx, sy = this.sy, sz = this.sz;
    const snx = this.snx, sny = this.sny, snz = this.snz;
    const cx = m.center[0], cy = m.center[1], cz = m.center[2];

    for (let v = 0; v < vcount; v++) {
      const i3 = v * 3;
      // model = rotY(angle): rotate around the model's bounding-sphere center
      // so off-center models still rotate in place.
      const lx = positions[i3] - cx, ly = positions[i3 + 1] - cy, lz = positions[i3 + 2] - cz;
      const mx = rotC * lx - rotS * lz + cx;
      const my = ly + cy;
      const mz = rotS * lx + rotC * lz + cz;
      // view = lookAt(eye, center): v' = (x·(p-e), y·(p-e), z·(p-e))
      const dx = mx - ex, dy = my - ey, dz = mz - ez;
      const vx = xx * dx + xy * dy + xz * dz;
      const vy = yx * dx + yy * dy + yz * dz;
      const vz = zx * dx + zy * dy + zz * dz; // negative in front of camera
      // perspective projection → NDC → screen
      const w = -vz;
      if (w > 0.0001) {
        const ndcX = (f * vx) / w;                    // aspect = 1
        const ndcY = (f * vy) / w;
        const ndcZ = ((far + near) * nf * vz + 2 * far * near * nf) / w;
        sx[v] = (ndcX * 0.5 + 0.5) * size;
        sy[v] = (0.5 - ndcY * 0.5) * size;            // NDC y-up → screen y-down
        sz[v] = ndcZ;
      } else {
        sx[v] = NaN; // clipped — any tri touching this vertex is skipped
      }
      // rotate the normal by the model rotation (view-space lighting isn't
      // needed — the shader lights in model space relative to camera fwd).
      const nx = normals[i3], ny = normals[i3 + 1], nz = normals[i3 + 2];
      snx[v] = rotC * nx - rotS * nz;
      sny[v] = ny;
      snz[v] = rotS * nx + rotC * nz;
    }

    // Light: matches THUMB_FS — L = normalize(0.5, 0.8, 0.4), fill 0.2, ndl*0.6.
    const lx = 0.5, ly = 0.8, lz = 0.4;
    const ll = Math.hypot(lx, ly, lz);
    const Lx = lx / ll, Ly = ly / ll, Lz = lz / ll;
    const br = m.baseColor[0], bg = m.baseColor[1], bb = m.baseColor[2];
    const indices = m.indices;

    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t], b = indices[t + 1], c = indices[t + 2];
      const ax = sx[a], ay = sy[a], az = sz[a];
      const bx = sx[b], by = sy[b], bz = sz[b];
      const cx2 = sx[c], cy2 = sy[c], cz2 = sz[c];
      if (Number.isNaN(ax) || Number.isNaN(bx) || Number.isNaN(cx2)) continue;
      // Depth clip: WebGL clips at ndc z in [-1,1]; approximate by dropping
      // tris entirely behind the near plane.
      if (az < -1 && bz < -1 && cz2 < -1) continue;
      if (az > 1 && bz > 1 && cz2 > 1) continue;

      // Face normal (screen-space winding for two-sided shading parity).
      const fnx = snx[a] + snx[b] + snx[c];
      const fny = sny[a] + sny[b] + sny[c];
      const fnz = snz[a] + snz[b] + snz[c];
      const fl = Math.hypot(fnx, fny, fnz) || 1;
      let Nx = fnx / fl, Ny = fny / fl, Nz = fnz / fl;
      // Two-sided lighting: the GLSL flips the normal for back faces
      // (gl_FrontFacing). The screen-space winding gives the same signal.
      const winding = (bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay);
      if (winding < 0) { Nx = -Nx; Ny = -Ny; Nz = -Nz; }

      let ndl = Nx * Lx + Ny * Ly + Nz * Lz;
      if (ndl < 0) ndl = 0;
      let r = br * (0.2 + ndl * 0.6);
      let g = bg * (0.2 + ndl * 0.6);
      let bCol = bb * (0.2 + ndl * 0.6);
      // Rim: pow(1 - max(dot(N, (0,0,1)), 0), 2) * 0.15 — N is the rotated
      // model-space normal; the camera looks down +Z of that space.
      const ndz = Nz > 0 ? Nz : 0;
      const rimT = 1 - ndz;
      const rim = rimT * rimT * 0.15;
      r += rim; g += rim; bCol += rim;
      const R = Math.min(255, (r * 255) | 0);
      const G = Math.min(255, (g * 255) | 0);
      const B = Math.min(255, (bCol * 255) | 0);

      // Rasterize: bounding box + edge functions, z-interpolated.
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx2)));
      const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx2)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy2)));
      const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy2)));
      const area = (bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay);
      if (area === 0) continue;
      const invArea = 1 / area;
      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const pxx = x + 0.5;
          const w0 = ((bx - pxx) * (cy2 - py) - (cx2 - pxx) * (by - py)) * invArea;
          const w1 = ((cx2 - pxx) * (ay - py) - (ax - pxx) * (cy2 - py)) * invArea;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * az + w1 * bz + w2 * cz2;
          const di = y * size + x;
          if (z >= depth[di]) continue;
          depth[di] = z;
          const pi = di * 4;
          px[pi] = R; px[pi + 1] = G; px[pi + 2] = B; px[pi + 3] = 255;
        }
      }
    }

    this.ctx.putImageData({ data: this.pixels, width: this.size, height: this.size } as ImageData, 0, 0);
    return true;
  }

  renderPlaceholder(): void {
    for (let i = 0; i < this.pixels.length; i += 4) {
      this.pixels[i] = 41; this.pixels[i + 1] = 43; this.pixels[i + 2] = 56; this.pixels[i + 3] = 255;
    }
    this.ctx.putImageData({ data: this.pixels, width: this.size, height: this.size } as ImageData, 0, 0);
  }

  dispose(): void {
    this.cache.clear();
    this.loading.clear();
  }
}
