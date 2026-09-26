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

import { declaredCompanionUri, loadModel, type ModelData } from "@downdraft/engine/libraries/models";
import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

export interface SoftwareThumbnailOptions {
  /** Resolve a modelUri to bytes. Default: fetch(uri).arrayBuffer(). */
  loadBytes?: (uri: string) => Promise<ArrayBuffer>;
  /** Resolve a material texture URI to bytes (e.g. sibling-file lookup
   *  relative to the model's directory). Omit to skip external textures. */
  resolveTexture?: (modelUri: string, uri: string) => Promise<ArrayBuffer | null>;
}

interface SoftTex {
  w: number;
  h: number;
  data: Uint8Array | Uint8ClampedArray; // RGBA
}

interface SoftMat {
  baseColor: [number, number, number];
  emissive: [number, number, number];
  tex: SoftTex | null;
  /** Decoding in flight — render untextured until it lands. */
  texPending: boolean;
  texOffset: [number, number];
  texScale: [number, number];
}

interface SoftModel {
  positions: Float32Array; // xyz per vertex
  indices: Uint16Array | Uint32Array;
  normals: Float32Array;   // smooth vertex normals, xyz per vertex
  uvs: Float32Array | null;      // uv per vertex
  vcols: Float32Array | null;    // rgb per vertex
  triMat: Uint16Array | null;    // material index per triangle (null → mats[0])
  mats: SoftMat[];
  center: [number, number, number];
  radius: number;
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
    [a, b, c].forEach((j) => {
      normals[j] += nx; normals[j + 1] += ny; normals[j + 2] += nz;
    });
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
  private resolveTexture: ((modelUri: string, uri: string) => Promise<ArrayBuffer | null>) | null;

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
    this.resolveTexture = opts?.resolveTexture ?? null;
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
      // Companion files — .mtl for OBJ (carries material colors + texture
      // URIs) and .bin for text .gltf. Resolved through the same sibling
      // mechanism as textures so filesystem-backed libraries work natively.
      const ext = filename.split(".").pop()?.toLowerCase();
      let mtl: ArrayBuffer | null = null, bin: ArrayBuffer | null = null;
      if (this.resolveTexture) {
        const stem = filename.replace(/\.[^.]+$/, "");
        const declared = declaredCompanionUri(buffer, ext ?? "");
        if (ext === "obj") {
          mtl = (declared ? await this.resolveTexture(modelUri, decodeURIComponent(declared)) : null)
            ?? await this.resolveTexture(modelUri, `${stem}.mtl`);
        } else if (ext === "gltf") {
          bin = (declared ? await this.resolveTexture(modelUri, decodeURIComponent(declared)) : null)
            ?? await this.resolveTexture(modelUri, `${stem}.bin`);
        }
      }
      const model = await loadModel(buffer, filename, mtl, bin) as ModelData;
      this.uploadModel(contentId, model, modelUri);
    } catch (err) {
      log.warn("SoftwareThumbnailRenderer", `Failed to load ${contentId} (${modelUri}): ${err}`);
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

  private uploadModel(contentId: string, model: ModelData, modelUri?: string): void {
    const meshes = model.meshes;
    if (!meshes || meshes.length === 0) { this.loadBuiltinCube(contentId); return; }
    let totalVerts = 0, totalIdx = 0;
    meshes.forEach((m) => { totalVerts += m.vertexCount; totalIdx += m.indexCount; });
    if (totalVerts > this.sx.length) {
      // Extremely large model — fall back to a cube rather than allocating
      // giant scratch buffers for a thumbnail.
      this.loadBuiltinCube(contentId);
      return;
    }
    const positions = new Float32Array(totalVerts * 3);
    const is32 = totalIdx > 65535;
    const indices = is32 ? new Uint32Array(totalIdx) : new Uint16Array(totalIdx);
    const multiMat = (model.materials?.length ?? 0) > 1
      || meshes.some((m) => (m.materialIndex ?? 0) > 0);
    const triMat = multiMat ? new Uint16Array(totalIdx / 3) : null;
    const anyUvs = meshes.some((m) => !!m.uvs);
    const anyCols = meshes.some((m) => !!m.colors);
    const uvs = anyUvs ? new Float32Array(totalVerts * 2) : null;
    const vcols = anyCols ? new Float32Array(totalVerts * 3).fill(1) : null;
    let vOff = 0, iOff = 0, vBase = 0;
    meshes.forEach((m) => {
      const stride = m.vertices.length / m.vertexCount;
      for (let v = 0; v < m.vertexCount; v++) {
        positions[vOff + v * 3] = m.vertices[v * stride];
        positions[vOff + v * 3 + 1] = m.vertices[v * stride + 1];
        positions[vOff + v * 3 + 2] = m.vertices[v * stride + 2];
      }
      if (uvs) {
        if (m.uvs) uvs.set(m.uvs.subarray(0, m.vertexCount * 2), vOff / 3 * 2);
        // missing uvs leave (0,0) — samples the texture's corner; acceptable
      }
      if (vcols && m.colors) {
        const cstride = m.colors.length / m.vertexCount;
        for (let v = 0; v < m.vertexCount; v++) {
          vcols[vOff + v * 3] = m.colors[v * cstride];
          vcols[vOff + v * 3 + 1] = m.colors[v * cstride + 1];
          vcols[vOff + v * 3 + 2] = m.colors[v * cstride + 2];
        }
      }
      vOff += m.vertexCount * 3;
      const src = m.indices;
      const mi = m.materialIndex ?? 0;
      for (let i = 0; i < m.indexCount; i++) (indices as any)[iOff + i] = src[i] + vBase;
      if (triMat) triMat.fill(mi, iOff / 3, (iOff + m.indexCount) / 3);
      iOff += m.indexCount;
      vBase += m.vertexCount;
    });
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

    // Materials: per-mesh baseColor/emissive + async texture decode.
    const mats: SoftMat[] = (model.materials ?? []).map((mat, mi) => {
      const sm: SoftMat = {
        baseColor: [mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]],
        emissive: mat.emissiveColor ? [...mat.emissiveColor] : [0, 0, 0],
        tex: null,
        texPending: !!(mat.textureData || mat.textureUri),
        texOffset: mat.textureTransform?.offset ?? [0, 0],
        texScale: mat.textureTransform?.scale ?? [1, 1],
      };
      if (sm.texPending) {
        void this.decodeMaterialTexture(mat.textureData, mat.textureUri, modelUri)
          .then((tex) => { sm.tex = tex; sm.texPending = false; })
          .catch(() => { sm.texPending = false; });
      }
      return sm;
    });
    if (mats.length === 0) {
      mats.push({
        baseColor: [0.78, 0.82, 0.88], emissive: [0, 0, 0],
        tex: null, texPending: false, texOffset: [0, 0], texScale: [1, 1],
      });
    }

    const normals = computeFlatNormals(positions, indices);
    if (this.cache.size >= this.maxCache) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(contentId, {
      positions, indices, normals, uvs, vcols, triMat, mats,
      center, radius,
    });
  }

  /** Decode embedded bytes or a resolved external URI into an RGBA tex map.
   *  Downscales to <=256px — thumbnails sample at 96px, no need for more. */
  private async decodeMaterialTexture(
    textureData: ArrayBuffer | null | undefined,
    textureUri: string | undefined,
    modelUri: string | undefined,
  ): Promise<SoftTex | null> {
    let bytes: ArrayBuffer | null = textureData ?? null;
    if (!bytes && textureUri && !textureUri.startsWith("data:") && modelUri && this.resolveTexture) {
      bytes = await this.resolveTexture(modelUri, decodeURIComponent(textureUri));
      // Basename fallback — FBX URIs frequently carry stale absolute paths.
      if (!bytes) {
        const base = decodeURIComponent(textureUri).split("/").pop() ?? "";
        if (base) bytes = await this.resolveTexture(modelUri, base);
      }
    }
    if (!bytes || bytes.byteLength <= 4) return null;
    try {
      const bmp = await createImageBitmap(bytes as any);
      const anyBmp = bmp as any;
      const MAX_TEX = 256;
      const scale = Math.min(1, MAX_TEX / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      // Native fast path — raw pixels, no canvas readback.
      if (scale >= 1 && typeof anyBmp.getPixelData === "function") {
        return { w, h, data: anyBmp.getPixelData() };
      }
      const c = new OffscreenCanvas(w, h);
      const cx = c.getContext("2d")!;
      cx.drawImage(bmp as any, 0, 0, w, h);
      const id = cx.getImageData(0, 0, w, h);
      try { (bmp as any).close?.(); } catch {}
      return { w, h, data: id.data };
    } catch {
      return null;
    }
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
      uvs: null, vcols: null, triMat: null,
      mats: [{
        baseColor, emissive: [0, 0, 0], tex: null, texPending: false,
        texOffset: [0, 0], texScale: [1, 1],
      }],
      center: bounds.center, radius: bounds.radius,
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

    // Lighting: hemisphere ambient (brighter from above) + key + weak fill.
    // Per-pixel interpolated normals → smooth shading instead of flat facets.
    const kl = Math.hypot(0.55, 0.75, 0.65);
    const Kx = 0.55 / kl, Ky = 0.75 / kl, Kz = 0.65 / kl;
    const fl2 = Math.hypot(-0.5, 0.1, 0.55);
    const Fx = -0.5 / fl2, Fy = 0.1 / fl2, Fz = 0.55 / fl2;
    const indices = m.indices;
    const uvs = m.uvs, vcols = m.vcols, triMat = m.triMat;
    const mats = m.mats;

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

      // Two-sided: flip shading normal by screen-space winding (same signal
      // the GLSL uses via gl_FrontFacing). Screen y is flipped vs NDC, so a
      // front-facing (CCW in NDC) tri has negative signed area here — keep
      // its authored normal; only back faces get flipped toward the camera.
      const winding = (bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay);
      const nSign = winding < 0 ? 1 : -1;

      const mat = mats[triMat ? triMat[t / 3] : 0] ?? mats[0];
      const br = mat.baseColor[0], bg = mat.baseColor[1], bb = mat.baseColor[2];
      const er = mat.emissive[0], eg = mat.emissive[1], eb = mat.emissive[2];
      const tex = mat.tex;
      const to0 = mat.texOffset[0], to1 = mat.texOffset[1];
      const ts0 = mat.texScale[0], ts1 = mat.texScale[1];
      const useTex = !!(tex && uvs);

      // Per-vertex shading inputs.
      const nax = snx[a] * nSign, nay = sny[a] * nSign, naz = snz[a] * nSign;
      const nbx = snx[b] * nSign, nby = sny[b] * nSign, nbz = snz[b] * nSign;
      const ncx = snx[c] * nSign, ncy = sny[c] * nSign, ncz = snz[c] * nSign;
      const ua = uvs ? uvs[a * 2] * ts0 + to0 : 0, va = uvs ? uvs[a * 2 + 1] * ts1 + to1 : 0;
      const ub = uvs ? uvs[b * 2] * ts0 + to0 : 0, vb = uvs ? uvs[b * 2 + 1] * ts1 + to1 : 0;
      const uc = uvs ? uvs[c * 2] * ts0 + to0 : 0, vc = uvs ? uvs[c * 2 + 1] * ts1 + to1 : 0;
      const cra = vcols ? vcols[a * 3] : 1, cga = vcols ? vcols[a * 3 + 1] : 1, cba = vcols ? vcols[a * 3 + 2] : 1;
      const crb = vcols ? vcols[b * 3] : 1, cgb = vcols ? vcols[b * 3 + 1] : 1, cbb = vcols ? vcols[b * 3 + 2] : 1;
      const crc = vcols ? vcols[c * 3] : 1, cgc = vcols ? vcols[c * 3 + 1] : 1, cbc = vcols ? vcols[c * 3 + 2] : 1;
      const tw = tex?.w ?? 0, th = tex?.h ?? 0, td = tex?.data;

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

          // Interpolated normal → per-pixel lighting.
          let nx = w0 * nax + w1 * nbx + w2 * ncx;
          let ny = w0 * nay + w1 * nby + w2 * ncy;
          let nz = w0 * naz + w1 * nbz + w2 * ncz;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl; ny /= nl; nz /= nl;
          const key = nx * Kx + ny * Ky + nz * Kz;
          const fill = nx * Fx + ny * Fy + nz * Fz;
          const hemi = ny * 0.5 + 0.5;
          const light = 0.30 + 0.30 * hemi + (key > 0 ? key * 0.62 : 0) + (fill > 0 ? fill * 0.16 : 0);

          // Albedo: material baseColor × vertex color × texture.
          let ar = br, ag = bg, ab = bb;
          if (vcols) {
            ar *= w0 * cra + w1 * crb + w2 * crc;
            ag *= w0 * cga + w1 * cgb + w2 * cgc;
            ab *= w0 * cba + w1 * cbb + w2 * cbc;
          }
          if (useTex && td) {
            let u = w0 * ua + w1 * ub + w2 * uc;
            let v = w0 * va + w1 * vb + w2 * vc;
            u -= Math.floor(u); v -= Math.floor(v);
            // Bilinear sample.
            const fu = u * tw - 0.5, fv = v * th - 0.5;
            let x0 = Math.floor(fu), y0 = Math.floor(fv);
            const fx = fu - x0, fy = fv - y0;
            x0 = ((x0 % tw) + tw) % tw; y0 = ((y0 % th) + th) % th;
            const x1 = (x0 + 1) % tw, y1 = (y0 + 1) % th;
            const p00 = (y0 * tw + x0) * 4, p10 = (y0 * tw + x1) * 4;
            const p01 = (y1 * tw + x0) * 4, p11 = (y1 * tw + x1) * 4;
            const wA = (1 - fx) * (1 - fy), wB = fx * (1 - fy);
            const wC = (1 - fx) * fy, wD = fx * fy;
            const inv255 = 1 / 255;
            ar *= (td[p00] * wA + td[p10] * wB + td[p01] * wC + td[p11] * wD) * inv255;
            ag *= (td[p00 + 1] * wA + td[p10 + 1] * wB + td[p01 + 1] * wC + td[p11 + 1] * wD) * inv255;
            ab *= (td[p00 + 2] * wA + td[p10 + 2] * wB + td[p01 + 2] * wC + td[p11 + 2] * wD) * inv255;
          }

          const ndz = nz > 0 ? nz : 0;
          const rimT = 1 - ndz;
          const rim = rimT * rimT * 0.10;
          const pi = di * 4;
          px[pi] = Math.min(255, (ar * light + er + rim) * 255) | 0;
          px[pi + 1] = Math.min(255, (ag * light + eg + rim) * 255) | 0;
          px[pi + 2] = Math.min(255, (ab * light + eb + rim) * 255) | 0;
          px[pi + 3] = 255;
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
