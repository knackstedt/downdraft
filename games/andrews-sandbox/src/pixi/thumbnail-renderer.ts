// ============================================================================
// ThumbnailRenderer — renders slowly-rotating 3D turntable thumbnails of GLB
// models on a dedicated OffscreenCanvas + WebGL2 context (separate from the
// PixiJS overlay's own context). Runs inside the pixi-ui Web Worker.
//
// Kenney GLBs use only KHR_materials_unlit / KHR_texture_transform (no
// Draco/meshopt), so @downdraft/library-models' loadModel() parses them in a
// worker with no codec wasm.
//
// Usage:
//   const tr = new ThumbnailRenderer(192);
//   await tr.loadModelThumb(modelUri, contentId);   // lazy, LRU-cached
//   tr.renderThumb(contentId, angle);              // draws one frame
//   // then copy the canvas to a PIXI texture via Texture.from(canvas) + update()
// ============================================================================

import { loadModel, type ModelData } from "@downdraft/library-models";

const THUMB_VS = /* glsl */ `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uMVP;
uniform mat4 uModel;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vNormal = normalize(mat3(uModel) * aNormal);
  vec4 wp = uModel * vec4(aPosition, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = uMVP * vec4(aPosition, 1.0);
}
`;

const THUMB_FS = /* glsl */ `
precision mediump float;
varying vec3 vNormal;
varying vec3 vWorldPos;
uniform vec3 uLightDir;
uniform vec3 uBaseColor;
void main() {
  vec3 N = normalize(vNormal);
  // Two-sided lighting: flip normal if it faces away from the camera.
  if (!gl_FrontFacing) N = -N;
  vec3 L = normalize(uLightDir);
  float ndl = max(dot(N, L), 0.0);
  float fill = 0.35;
  vec3 col = uBaseColor * (fill + ndl * 0.75);
  float rim = pow(1.0 - max(dot(N, vec3(0.0, 0.0, 1.0)), 0.0), 2.0) * 0.25;
  col += rim;
  gl_FragColor = vec4(col, 1.0);
}
`;

interface ThumbModel {
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  indexCount: number;
  indexType: number;
  /** Center of the bounding sphere (model space). */
  center: [number, number, number];
  /** Bounding sphere radius. */
  radius: number;
  /** Base color from the model's first material (RGBA 0..1). */
  baseColor: [number, number, number];
}

function mat4Identity(): Float32Array {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  // Column-major: element at (row r, col c) is stored at [c*4+r].
  // C = A * B  →  C[r,c] = sum_k A[r,k] * B[k,c]
  // In storage: o[c*4+r] = sum_k a[k*4+r] * b[c*4+k]
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c*4+r] = a[0*4+r]*b[c*4+0] + a[1*4+r]*b[c*4+1] + a[2*4+r]*b[c*4+2] + a[3*4+r]*b[c*4+3];
    }
  }
  return o;
}

function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1.0 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function mat4LookAt(eye: [number,number,number], target: [number,number,number], up: [number,number,number]): Float32Array {
  const z = [eye[0]-target[0], eye[1]-target[1], eye[2]-target[2]];
  let zl = Math.hypot(z[0],z[1],z[2]) || 1; z[0]/=zl; z[1]/=zl; z[2]/=zl;
  const x = [up[1]*z[2]-up[2]*z[1], up[2]*z[0]-up[0]*z[2], up[0]*z[1]-up[1]*z[0]];
  let xl = Math.hypot(x[0],x[1],x[2]) || 1; x[0]/=xl; x[1]/=xl; x[2]/=xl;
  const y = [z[1]*x[2]-z[2]*x[1], z[2]*x[0]-z[0]*x[2], z[0]*x[1]-z[1]*x[0]];
  const m = new Float32Array(16);
  m[0]=x[0]; m[1]=y[0]; m[2]=z[0]; m[3]=0;
  m[4]=x[1]; m[5]=y[1]; m[6]=z[1]; m[7]=0;
  m[8]=x[2]; m[9]=y[2]; m[10]=z[2]; m[11]=0;
  m[12]=-(x[0]*eye[0]+x[1]*eye[1]+x[2]*eye[2]);
  m[13]=-(y[0]*eye[0]+y[1]*eye[1]+y[2]*eye[2]);
  m[14]=-(z[0]*eye[0]+z[1]*eye[1]+z[2]*eye[2]);
  m[15]=1;
  return m;
}

function mat4RotateY(angle: number): Float32Array {
  const c = Math.cos(angle), s = Math.sin(angle);
  return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
}

function mat4Translate(tx: number, ty: number, tz: number): Float32Array {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1]);
}

/** Compute per-face normals for a position+index buffer (flat shading). */
function computeFlatNormals(positions: Float32Array, indices: Uint16Array | Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i+1] * 3, c = indices[i+2] * 3;
    const ux = positions[b]   - positions[a];
    const uy = positions[b+1] - positions[a+1];
    const uz = positions[b+2] - positions[a+2];
    const vx = positions[c]   - positions[a];
    const vy = positions[c+1] - positions[a+1];
    const vz = positions[c+2] - positions[a+2];
    let nx = uy*vz - uz*vy;
    let ny = uz*vx - ux*vz;
    let nz = ux*vy - uy*vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    for (const j of [a, b, c]) {
      normals[j]   += nx;
      normals[j+1] += ny;
      normals[j+2] += nz;
    }
  }
  // Normalize accumulated normals
  for (let i = 0; i < normals.length; i += 3) {
    const nl = Math.hypot(normals[i], normals[i+1], normals[i+2]) || 1;
    normals[i] /= nl; normals[i+1] /= nl; normals[i+2] /= nl;
  }
  return normals;
}

export class ThumbnailRenderer {
  private canvas: OffscreenCanvas;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private aPosLoc: number;
  private aNormLoc: number;
  private uMVPLoc: WebGLUniformLocation;
  private uModelLoc: WebGLUniformLocation;
  private uLightDirLoc: WebGLUniformLocation;
  private uBaseColorLoc: WebGLUniformLocation;
  private size: number;

  /** LRU cache: contentId → ThumbModel. */
  private cache = new Map<string, ThumbModel>();
  /** Set of contentIds currently loading (prevents duplicate fetches). */
  private loading = new Set<string>();
  private maxCache = 512;
  private _pixelsLogged = false;
  private _clearTested = false;
  private _drawTested = false;

  constructor(size = 192) {
    this.size = size;
    this.canvas = new OffscreenCanvas(size, size);
    const gl = this.canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("ThumbnailRenderer: WebGL2 not available in worker");
    this.gl = gl;
    gl.enable(gl.DEPTH_TEST);
    // Disable face culling — Kenney GLBs may have inconsistent winding order.
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.16, 0.17, 0.22, 1.0);

    const vs = this.compile(gl.VERTEX_SHADER, THUMB_VS);
    const fs = this.compile(gl.FRAGMENT_SHADER, THUMB_FS);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("ThumbnailRenderer: program link failed: " + gl.getProgramInfoLog(prog));
    }
    this.program = prog;
    this.aPosLoc = gl.getAttribLocation(prog, "aPosition");
    this.aNormLoc = gl.getAttribLocation(prog, "aNormal");
    this.uMVPLoc = gl.getUniformLocation(prog, "uMVP")!;
    this.uModelLoc = gl.getUniformLocation(prog, "uModel")!;
    this.uLightDirLoc = gl.getUniformLocation(prog, "uLightDir")!;
    this.uBaseColorLoc = gl.getUniformLocation(prog, "uBaseColor")!;
  }

  /** The thumbnail canvas — copy to a PIXI texture via Texture.from(this.canvas). */
  get canvasElement(): OffscreenCanvas { return this.canvas; }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error("ThumbnailRenderer: shader compile failed: " + gl.getShaderInfoLog(s));
    }
    return s;
  }

  /** Whether a model is loaded (or loading) for the given contentId. */
  has(contentId: string): boolean {
    return this.cache.has(contentId) || this.loading.has(contentId);
  }

  /** Load + upload a model's geometry. Resolves when ready (or on error). No-op if cached/loading. */
  async loadModelThumb(modelUri: string, contentId: string): Promise<void> {
    if (this.cache.has(contentId) || this.loading.has(contentId)) return;
    this.loading.add(contentId);
    try {
      const resp = await fetch(modelUri);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      const filename = modelUri.split("/").pop() ?? "model.glb";
      const model = await loadModel(buffer, filename) as ModelData;
      this.uploadModel(contentId, model);
      const m = this.cache.get(contentId);
      // console.log(`[ThumbnailRenderer] Loaded ${contentId}: ${model.meshes?.length ?? 0} meshes, verts=${model.meshes?.reduce((s,m)=>s+m.vertexCount,0) ?? 0}, bounds=${JSON.stringify(model.bounds)}, radius=${m?.radius.toFixed(3)}`);
    } catch (err) {
      console.warn(`[ThumbnailRenderer] Failed to load ${contentId} (${modelUri}):`, err);
      // Fall back to a builtin cube so the card isn't blank.
      this.uploadBuiltinCube(contentId);
    } finally {
      this.loading.delete(contentId);
    }
  }

  /** Upload a builtin cube for contentIds with no modelUri (builtin:cube etc.). */
  loadBuiltinCube(contentId: string): void {
    if (this.cache.has(contentId)) return;
    this.uploadBuiltinCube(contentId);
  }

  /** Upload a builtin sphere for contentIds with no modelUri (builtin:sphere etc.). */
  loadBuiltinSphere(contentId: string): void {
    if (this.cache.has(contentId)) return;
    this.uploadBuiltinSphere(contentId);
  }

  private uploadBuiltinCube(contentId: string): void {
    const positions = new Float32Array([
      -0.5,-0.5,-0.5,  0.5,-0.5,-0.5,  0.5,0.5,-0.5, -0.5,0.5,-0.5,
      -0.5,-0.5, 0.5,  0.5,-0.5, 0.5,  0.5,0.5, 0.5, -0.5,0.5, 0.5,
    ]);
    const indices = new Uint16Array([
      0,1,2, 0,2,3,  4,6,5, 4,7,6,
      0,3,7, 0,7,4,  1,5,6, 1,6,2,
      3,2,6, 3,6,7,  0,4,5, 0,5,1,
    ]);
    this.uploadGeometry(contentId, positions, indices, { center: [0,0,0], radius: Math.sqrt(3)/2 });
  }

  private uploadBuiltinSphere(contentId: string): void {
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
    this.uploadGeometry(contentId, new Float32Array(positions), new Uint16Array(indices), { center: [0,0,0], radius: 0.5 });
  }

  private uploadModel(contentId: string, model: ModelData): void {
    // Concatenate all mesh positions + indices into one buffer.
    const meshes = model.meshes;
    if (!meshes || meshes.length === 0) { this.uploadBuiltinCube(contentId); return; }
    let totalVerts = 0, totalIdx = 0;
    for (const m of meshes) { totalVerts += m.vertexCount; totalIdx += m.indexCount; }
    const positions = new Float32Array(totalVerts * 3);
    const is32 = totalIdx > 65535;
    const indices = is32 ? new Uint32Array(totalIdx) : new Uint16Array(totalIdx);
    let vOff = 0, iOff = 0, vBase = 0;
    for (const m of meshes) {
      // GLTF parser stores 6 floats/vert (pos.xyz + norm.xyz interleaved).
      // Other parsers may store 3 floats/vert (pos.xyz only). Detect stride.
      const stride = m.vertices.length / m.vertexCount;
      for (let v = 0; v < m.vertexCount; v++) {
        positions[vOff + v * 3]     = m.vertices[v * stride];
        positions[vOff + v * 3 + 1] = m.vertices[v * stride + 1];
        positions[vOff + v * 3 + 2] = m.vertices[v * stride + 2];
      }
      vOff += m.vertexCount * 3;
      // Rebase indices
      const src = m.indices;
      for (let i = 0; i < m.indexCount; i++) {
        (indices as any)[iOff + i] = src[i] + vBase;
      }
      iOff += m.indexCount;
      vBase += m.vertexCount;
    }
    // Bounds
    let center: [number, number, number] = [0, 0, 0];
    let radius = 0.5;
    if (model.bounds) {
      const b = model.bounds;
      center = [(b.min[0]+b.max[0])/2, (b.min[1]+b.max[1])/2, (b.min[2]+b.max[2])/2];
      radius = Math.max(
        Math.hypot(b.max[0]-center[0], b.max[1]-center[1], b.max[2]-center[2]),
        Math.hypot(b.min[0]-center[0], b.min[1]-center[1], b.min[2]-center[2]),
      );
    } else {
      // Compute from positions
      let min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
      for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (positions[i+k] < min[k]) min[k] = positions[i+k];
          if (positions[i+k] > max[k]) max[k] = positions[i+k];
        }
      }
      center = [(min[0]+max[0])/2, (min[1]+max[1])/2, (min[2]+max[2])/2];
      radius = Math.max(
        Math.hypot(max[0]-center[0], max[1]-center[1], max[2]-center[2]),
        Math.hypot(min[0]-center[0], min[1]-center[1], min[2]-center[2]),
      );
    }
    if (radius <= 0) radius = 0.5;
    // Extract base color from the model's first material (if any).
    let baseColor: [number, number, number] = [0.78, 0.82, 0.88];
    if (model.materials && model.materials.length > 0) {
      const mat = model.materials[0];
      baseColor = [mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]];
    }
    this.uploadGeometry(contentId, positions, indices, { center, radius }, baseColor);
  }

  private uploadGeometry(contentId: string, positions: Float32Array, indices: Uint16Array | Uint32Array, bounds: { center: [number,number,number]; radius: number }, baseColor: [number, number, number] = [0.78, 0.82, 0.88]): void {
    const gl = this.gl;
    const normals = computeFlatNormals(positions, indices);
    // Interleave position(3) + normal(3)
    const vdata = new Float32Array(positions.length * 2);
    for (let i = 0; i < positions.length; i += 3) {
      vdata[i*2+0] = positions[i];
      vdata[i*2+1] = positions[i+1];
      vdata[i*2+2] = positions[i+2];
      vdata[i*2+3] = normals[i];
      vdata[i*2+4] = normals[i+1];
      vdata[i*2+5] = normals[i+2];
    }
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vdata, gl.STATIC_DRAW);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    // LRU eviction
    if (this.cache.size >= this.maxCache) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.evict(oldest);
    }
    this.cache.set(contentId, {
      vbo, ibo, indexCount: indices.length,
      indexType: indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      center: bounds.center, radius: bounds.radius, baseColor,
    });
  }

  private evict(contentId: string): void {
    const m = this.cache.get(contentId);
    if (!m) return;
    const gl = this.gl;
    gl.deleteBuffer(m.vbo);
    gl.deleteBuffer(m.ibo);
    this.cache.delete(contentId);
  }

  /** Render one turntable frame for the given contentId at the given Y angle.
   *  Reads pixels immediately after draw and returns the flipped RGBA pixel data. */
  renderThumb(contentId: string, angle: number): Uint8ClampedArray | null {
    const gl = this.gl;
    const m = this.cache.get(contentId);
    if (!m) return null; // not loaded yet
    gl.viewport(0, 0, this.size, this.size);
    gl.clearColor(0.16, 0.17, 0.22, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);

    // Camera: fixed position looking at the model center. Only the model rotates.
    const radius = Math.max(m.radius, 0.1);
    const dist = radius * 3.0;
    const eye: [number, number, number] = [
      m.center[0],
      m.center[1] + m.radius * 0.4,
      m.center[2] + dist,
    ];
    const near = dist * 0.01;
    const far = dist * 10;
    const proj = mat4Perspective(45 * Math.PI / 180, 1, near, far);
    const view = mat4LookAt(eye, m.center, [0, 1, 0]);
    const rot = mat4RotateY(angle);
    const model = mat4Multiply(rot, mat4Identity());
    const mvp = mat4Multiply(proj, mat4Multiply(view, model));

    gl.uniformMatrix4fv(this.uMVPLoc, false, mvp);
    gl.uniformMatrix4fv(this.uModelLoc, false, model);
    gl.uniform3f(this.uLightDirLoc, 0.5, 0.8, 0.4);
    // Per-model color based on content ID hash for visual variety.
    let hash = 0;
    for (let k = 0; k < contentId.length; k++) hash = (hash * 31 + contentId.charCodeAt(k)) | 0;
    const cr = 0.5 + 0.3 * ((hash & 0xFF) / 255);
    const cg = 0.5 + 0.3 * (((hash >> 8) & 0xFF) / 255);
    const cb = 0.5 + 0.3 * (((hash >> 16) & 0xFF) / 255);
    gl.uniform3f(this.uBaseColorLoc, cr, cg, cb);

    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    gl.enableVertexAttribArray(this.aPosLoc);
    gl.vertexAttribPointer(this.aPosLoc, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(this.aNormLoc);
    gl.vertexAttribPointer(this.aNormLoc, 3, gl.FLOAT, false, 24, 12);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
    gl.drawElements(gl.TRIANGLES, m.indexCount, m.indexType, 0);

    gl.disableVertexAttribArray(this.aPosLoc);
    gl.disableVertexAttribArray(this.aNormLoc);

    gl.finish();

    const buf = new Uint8Array(this.size * this.size * 4);
    gl.readPixels(0, 0, this.size, this.size, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    // Flip vertically (WebGL bottom-left origin → top-left for canvas)
    const flipped = new Uint8ClampedArray(buf.length);
    const rowLen = this.size * 4;
    for (let y = 0; y < this.size; y++) {
      const srcRow = (this.size - 1 - y) * rowLen;
      const dstRow = y * rowLen;
      flipped.set(buf.subarray(srcRow, srcRow + rowLen), dstRow);
    }
    return flipped;
  }

  /** Read the rendered pixels into a Uint8ClampedArray (RGBA, size×size). */
  readPixels(): Uint8ClampedArray {
    const gl = this.gl;
    const buf = new Uint8Array(this.size * this.size * 4);
    gl.readPixels(0, 0, this.size, this.size, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // One-time debug: check if pixels are non-zero
    if (!this._pixelsLogged) {
      this._pixelsLogged = true;
      let nonZero = 0;
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i] > 20 || buf[i+1] > 20 || buf[i+2] > 20) { nonZero++; }
      }
      console.log(`[ThumbnailRenderer] readPixels debug: ${nonZero}/${buf.length/4} non-zero pixels, first 8 bytes: [${buf.slice(0,8).join(",")}]`);
    }
    // Flip vertically (WebGL bottom-left origin → top-left for canvas)
    const flipped = new Uint8ClampedArray(buf.length);
    const rowLen = this.size * 4;
    for (let y = 0; y < this.size; y++) {
      const srcRow = (this.size - 1 - y) * rowLen;
      const dstRow = y * rowLen;
      flipped.set(buf.subarray(srcRow, srcRow + rowLen), dstRow);
    }
    return flipped;
  }

  /** Render a placeholder (empty) frame — clears to bg. Used when no model loaded. */
  renderPlaceholder(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.size, this.size);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /** Dispose all GPU resources + lose the WebGL context. */
  dispose(): void {
    for (const id of Array.from(this.cache.keys())) this.evict(id);
    const gl = this.gl;
    gl.deleteProgram(this.program);
    const ext = gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }
}
