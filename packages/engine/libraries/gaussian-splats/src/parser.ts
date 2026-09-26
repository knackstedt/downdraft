// ============================================================================
// Gaussian splat parsers — PLY (ascii + binary_little_endian) and .splat
//
// Outputs a Structure-of-Arrays (SoA) `GaussianSplatData` for direct GPU upload:
//   position:  Float32Array(count * 3)
//   scale:     Float32Array(count * 3)   — exp()-transformed
//   rotation:  Float32Array(count * 4)   — quaternion w,x,y,z, normalized
//   color:     Float32Array(count * 4)   — r,g,b (DC color) + a (opacity sigmoid)
//   shCoeffs:  Float32Array(count * SH_REST_COEFFS_PER_DEGREE[shDegree])
//              raw f_rest coefficients (empty when shDegree === 0)
//
// The single-splat `GaussianSplat` tuple type is kept as an escape hatch for
// callers that want one splat at a time (e.g. debugging, CPU-side queries).
// ============================================================================

import { assertBounds, assertCount, MAX_VERTEX_COUNT } from "@downdraft/engine";

// ── SH coefficient counts ──
//
// INRIA PLY stores 3 DC coefficients (f_dc_0..2) and up to 45 "rest"
// coefficients (f_rest_0..44). The DC term is degree-0; the rest terms cover
// degrees 1..N. Total SH coeffs for degree N = 3 * (N+1)^2 per splat
// (3 channels × (N+1)^2 basis functions). DC = 3*1 = 3; rest = total - DC.
//
//   degree 0 → 0  rest coeffs (DC only)
//   degree 1 → 9  rest coeffs (f_rest_0..8)
//   degree 2 → 24 rest coeffs (f_rest_0..23)
//   degree 3 → 45 rest coeffs (f_rest_0..44)
export const SH_REST_COEFFS_PER_DEGREE = [0, 9, 24, 45] as const;
export const MAX_SH_DEGREE = 3;
export const SH_REST_COEFFS_MAX = SH_REST_COEFFS_PER_DEGREE[MAX_SH_DEGREE]; // 45

// ── Types ──

/** Single-splat tuple (escape hatch / debugging). */
export interface GaussianSplat {
  position: [number, number, number];
  scale: [number, number, number];
  rotation: [number, number, number, number]; // w, x, y, z
  color: [number, number, number, number]; // r, g, b, a
  opacity: number;
}

/** SoA splat data — typed arrays per attribute for direct GPU upload. */
export interface GaussianSplatData {
  /** Number of splats. */
  count: number;
  /** Parsed SH degree (0 if no f_rest coefficients present). */
  shDegree: number;
  /** Parser format version (1 = PLY, 2 = .splat). */
  version: number;
  /** x, y, z per splat (count * 3). */
  position: Float32Array;
  /** x, y, z per splat, exp()-transformed (count * 3). */
  scale: Float32Array;
  /** quaternion w, x, y, z per splat, normalized (count * 4). */
  rotation: Float32Array;
  /** r, g, b (DC color) + a (opacity sigmoid) per splat (count * 4). */
  color: Float32Array;
  /** Raw f_rest SH coefficients (count * SH_REST_COEFFS_PER_DEGREE[shDegree]). Empty when shDegree === 0. */
  shCoeffs: Float32Array;
}

export interface PLYHeader {
  vertexCount: number;
  /** Full property lines (e.g. "property float x"). */
  properties: string[];
  /** Property names in order (e.g. "x", "y", "z", "scale_0", ...). */
  propertyNames: string[];
  format: string;
  /** Byte offset to the start of vertex data (after "end_header\n"). */
  headerBytes: number;
  /** Detected SH degree from f_rest property count. */
  shDegree: number;
}

// ── Helpers ──

/** SH C0 coefficient → color: color = 0.5 + C0 * 0.282095. */
const SH_C0 = 0.28209479177387814;

/** Opacity sigmoid: alpha = 1 / (1 + exp(-opacity)). */
function sigmoidOpacity(o: number): number {
  return 1.0 / (1.0 + Math.exp(-o));
}

/** Detect SH degree from the number of f_rest properties. */
function detectShDegree(propertyNames: string[]): number {
  let restCount = 0;
  propertyNames.forEach((name) => {
    if (name.startsWith("f_rest_")) restCount++;
  });
  if (restCount >= 45) return 3;
  if (restCount >= 24) return 2;
  if (restCount >= 9) return 1;
  return 0;
}

/** Normalize a quaternion (w, x, y, z) in place into a Float32Array slice. */
function normalizeQuat(out: Float32Array, base: number, w: number, x: number, y: number, z: number): void {
  const len = Math.sqrt(w * w + x * x + y * y + z * z);
  const inv = len > 0 ? 1.0 / len : 1.0;
  out[base] = w * inv;
  out[base + 1] = x * inv;
  out[base + 2] = y * inv;
  out[base + 3] = z * inv;
}

/** Build an empty (zeroed) GaussianSplatData for `count` splats at `shDegree`. */
function emptySplatData(count: number, shDegree: number, version: number): GaussianSplatData {
  const restCoeffs = SH_REST_COEFFS_PER_DEGREE[shDegree] ?? 0;
  return {
    count,
    shDegree,
    version,
    position: new Float32Array(count * 3),
    scale: new Float32Array(count * 3),
    rotation: new Float32Array(count * 4),
    color: new Float32Array(count * 4),
    shCoeffs: restCoeffs > 0 ? new Float32Array(count * restCoeffs) : new Float32Array(0),
  };
}

// ── PLY header parsing ──

function readPLYHeader(data: Uint8Array): PLYHeader {
  const text = new TextDecoder().decode(data.slice(0, 2048));
  const lines = text.split("\n");
  let vertexCount = 0;
  const properties: string[] = [];
  const propertyNames: string[] = [];
  let format = "ascii";
  let headerBytes = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "end_header") {
      // Compute byte offset: sum of (line length + 1 for newline) up to and
      // including the "end_header" line.
      let bytes = 0;
      for (let j = 0; j <= i; j++) {
        bytes += lines[j].length + 1;
      }
      headerBytes = bytes;
      break;
    }
    if (line.startsWith("format")) {
      format = line.split(/\s+/)[1];
    }
    if (line.startsWith("element vertex")) {
      vertexCount = parseInt(line.split(/\s+/)[2], 10);
    }
    if (line.startsWith("property")) {
      properties.push(line);
      const parts = line.split(/\s+/);
      propertyNames.push(parts[parts.length - 1]);
    }
  }

  const shDegree = detectShDegree(propertyNames);
  return { vertexCount, properties, propertyNames, format, headerBytes, shDegree };
}

// ── PLY parsing ──

export function parsePLY(data: Uint8Array): GaussianSplatData {
  const header = readPLYHeader(data);
  assertCount("splats", header.vertexCount, MAX_VERTEX_COUNT);

  if (header.vertexCount === 0) {
    return emptySplatData(0, header.shDegree, 1);
  }

  if (header.format === "ascii") {
    return parsePLYAscii(data, header);
  }
  if (header.format === "binary_little_endian") {
    return parsePLYBinaryLE(data, header);
  }
  // Unknown format — return empty rather than throw (callers check count).
  return emptySplatData(0, 0, 1);
}

function parsePLYAscii(data: Uint8Array, header: PLYHeader): GaussianSplatData {
  const text = new TextDecoder().decode(data);
  const lines = text.split("\n");
  let dataStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "end_header") {
      dataStart = i + 1;
      break;
    }
  }

  const count = header.vertexCount;
  const result = emptySplatData(count, header.shDegree, 1);
  const propIndex: Record<string, number> = {};
  header.propertyNames.forEach((name, i) => { propIndex[name] = i; });
  const restCoeffs = SH_REST_COEFFS_PER_DEGREE[header.shDegree] ?? 0;

  for (let i = 0; i < count && dataStart + i < lines.length; i++) {
    const parts = lines[dataStart + i].trim().split(/\s+/).map(Number);
    if (parts.length < 3) continue;
    const i3 = i * 3;
    const i4 = i * 4;

    // Position
    result.position[i3] = parts[propIndex["x"] ?? 0] ?? 0;
    result.position[i3 + 1] = parts[propIndex["y"] ?? 1] ?? 0;
    result.position[i3 + 2] = parts[propIndex["z"] ?? 2] ?? 0;

    // Scale (exp-transform)
    const s0 = propIndex["scale_0"] !== undefined ? parts[propIndex["scale_0"]] : Math.log(0.01);
    const s1 = propIndex["scale_1"] !== undefined ? parts[propIndex["scale_1"]] : Math.log(0.01);
    const s2 = propIndex["scale_2"] !== undefined ? parts[propIndex["scale_2"]] : Math.log(0.01);
    result.scale[i3] = Math.exp(s0);
    result.scale[i3 + 1] = Math.exp(s1);
    result.scale[i3 + 2] = Math.exp(s2);

    // Rotation (quaternion w,x,y,z, normalized)
    const rw = propIndex["rot_0"] !== undefined ? parts[propIndex["rot_0"]] : 1;
    const rx = propIndex["rot_1"] !== undefined ? parts[propIndex["rot_1"]] : 0;
    const ry = propIndex["rot_2"] !== undefined ? parts[propIndex["rot_2"]] : 0;
    const rz = propIndex["rot_3"] !== undefined ? parts[propIndex["rot_3"]] : 0;
    normalizeQuat(result.rotation, i4, rw, rx, ry, rz);

    // DC color + opacity
    const r = propIndex["f_dc_0"] !== undefined ? parts[propIndex["f_dc_0"]] : 0.5;
    const g = propIndex["f_dc_1"] !== undefined ? parts[propIndex["f_dc_1"]] : 0.5;
    const b = propIndex["f_dc_2"] !== undefined ? parts[propIndex["f_dc_2"]] : 0.5;
    const o = propIndex["opacity"] !== undefined ? parts[propIndex["opacity"]] : 0;
    result.color[i4] = Math.max(0, Math.min(1, 0.5 + r * SH_C0));
    result.color[i4 + 1] = Math.max(0, Math.min(1, 0.5 + g * SH_C0));
    result.color[i4 + 2] = Math.max(0, Math.min(1, 0.5 + b * SH_C0));
    result.color[i4 + 3] = sigmoidOpacity(o);

    // SH rest coefficients
    if (restCoeffs > 0) {
      const shBase = i * restCoeffs;
      for (let c = 0; c < restCoeffs; c++) {
        const key = `f_rest_${c}`;
        result.shCoeffs[shBase + c] = propIndex[key] !== undefined ? parts[propIndex[key]] : 0;
      }
    }
  }

  return result;
}

function parsePLYBinaryLE(data: Uint8Array, header: PLYHeader): GaussianSplatData {
  const offset = header.headerBytes;
  const count = header.vertexCount;
  const stride = header.properties.length * 4; // all float32
  assertBounds("splats binary data", offset, count * stride, data.byteLength);

  const view = new DataView(data.buffer, data.byteOffset + offset, count * stride);
  const result = emptySplatData(count, header.shDegree, 1);
  const propIndex: Record<string, number> = {};
  header.propertyNames.forEach((name, i) => { propIndex[name] = i; });
  const restCoeffs = SH_REST_COEFFS_PER_DEGREE[header.shDegree] ?? 0;

  for (let i = 0; i < count; i++) {
    const base = i * stride;
    const i3 = i * 3;
    const i4 = i * 4;

    // Position
    result.position[i3] = view.getFloat32(base + (propIndex["x"] ?? 0) * 4, true);
    result.position[i3 + 1] = view.getFloat32(base + (propIndex["y"] ?? 1) * 4, true);
    result.position[i3 + 2] = view.getFloat32(base + (propIndex["z"] ?? 2) * 4, true);

    // Scale (exp-transform)
    const s0 = propIndex["scale_0"] !== undefined ? view.getFloat32(base + propIndex["scale_0"] * 4, true) : Math.log(0.01);
    const s1 = propIndex["scale_1"] !== undefined ? view.getFloat32(base + propIndex["scale_1"] * 4, true) : Math.log(0.01);
    const s2 = propIndex["scale_2"] !== undefined ? view.getFloat32(base + propIndex["scale_2"] * 4, true) : Math.log(0.01);
    result.scale[i3] = Math.exp(s0);
    result.scale[i3 + 1] = Math.exp(s1);
    result.scale[i3 + 2] = Math.exp(s2);

    // Rotation (quaternion w,x,y,z, normalized)
    const rw = propIndex["rot_0"] !== undefined ? view.getFloat32(base + propIndex["rot_0"] * 4, true) : 1;
    const rx = propIndex["rot_1"] !== undefined ? view.getFloat32(base + propIndex["rot_1"] * 4, true) : 0;
    const ry = propIndex["rot_2"] !== undefined ? view.getFloat32(base + propIndex["rot_2"] * 4, true) : 0;
    const rz = propIndex["rot_3"] !== undefined ? view.getFloat32(base + propIndex["rot_3"] * 4, true) : 0;
    normalizeQuat(result.rotation, i4, rw, rx, ry, rz);

    // DC color + opacity
    const r = propIndex["f_dc_0"] !== undefined ? view.getFloat32(base + propIndex["f_dc_0"] * 4, true) : 0.5;
    const g = propIndex["f_dc_1"] !== undefined ? view.getFloat32(base + propIndex["f_dc_1"] * 4, true) : 0.5;
    const b = propIndex["f_dc_2"] !== undefined ? view.getFloat32(base + propIndex["f_dc_2"] * 4, true) : 0.5;
    const o = propIndex["opacity"] !== undefined ? view.getFloat32(base + propIndex["opacity"] * 4, true) : 0;
    result.color[i4] = Math.max(0, Math.min(1, 0.5 + r * SH_C0));
    result.color[i4 + 1] = Math.max(0, Math.min(1, 0.5 + g * SH_C0));
    result.color[i4 + 2] = Math.max(0, Math.min(1, 0.5 + b * SH_C0));
    result.color[i4 + 3] = sigmoidOpacity(o);

    // SH rest coefficients
    if (restCoeffs > 0) {
      const shBase = i * restCoeffs;
      for (let c = 0; c < restCoeffs; c++) {
        const key = `f_rest_${c}`;
        result.shCoeffs[shBase + c] = propIndex[key] !== undefined
          ? view.getFloat32(base + propIndex[key] * 4, true)
          : 0;
      }
    }
  }

  return result;
}

// ── .splat parsing ──
//
// The antimatter15 .splat format is a 32-byte-per-splat binary blob with no
// SH coefficients. Layout: position(3f) | scale(3f) | color(4u8) | rotation(4u8).
// This parser reads the float32 position/scale fields; the u8 color/rotation
// fields are read and converted to float.
export function parseSplat(data: Uint8Array): GaussianSplatData {
  const stride = 32;
  const count = Math.floor(data.byteLength / stride);
  assertCount("splats", count, MAX_VERTEX_COUNT);

  if (count === 0) {
    return emptySplatData(0, 0, 2);
  }

  const view = new DataView(data.buffer, data.byteOffset, count * stride);
  const result = emptySplatData(count, 0, 2);

  for (let i = 0; i < count; i++) {
    const base = i * stride;
    const i3 = i * 3;
    const i4 = i * 4;

    // Position (float32 × 3)
    result.position[i3] = view.getFloat32(base, true);
    result.position[i3 + 1] = view.getFloat32(base + 4, true);
    result.position[i3 + 2] = view.getFloat32(base + 8, true);

    // Scale (float32 × 3, exp-transform)
    result.scale[i3] = Math.exp(view.getFloat32(base + 12, true));
    result.scale[i3 + 1] = Math.exp(view.getFloat32(base + 16, true));
    result.scale[i3 + 2] = Math.exp(view.getFloat32(base + 20, true));

    // Color (u8 × 4, normalized to 0..1)
    result.color[i4] = view.getUint8(base + 24) / 255;
    result.color[i4 + 1] = view.getUint8(base + 25) / 255;
    result.color[i4 + 2] = view.getUint8(base + 26) / 255;
    result.color[i4 + 3] = view.getUint8(base + 27) / 255;

    // Rotation (u8 × 4 → quaternion, normalized)
    const rw = view.getUint8(base + 28) / 127.5 - 1;
    const rx = view.getUint8(base + 29) / 127.5 - 1;
    const ry = view.getUint8(base + 30) / 127.5 - 1;
    const rz = view.getUint8(base + 31) / 127.5 - 1;
    normalizeQuat(result.rotation, i4, rw, rx, ry, rz);
  }

  return result;
}

// ── Dispatch ──

export function parseGaussianSplatFile(data: Uint8Array, format: "ply" | "splat" = "ply"): GaussianSplatData {
  if (format === "splat") return parseSplat(data);
  return parsePLY(data);
}

// ── Escape hatch: extract a single splat as a tuple ──

/** Extract splat `i` as a tuple (escape hatch for debugging / CPU queries). */
export function getSplat(data: GaussianSplatData, i: number): GaussianSplat {
  const i3 = i * 3;
  const i4 = i * 4;
  return {
    position: [data.position[i3], data.position[i3 + 1], data.position[i3 + 2]],
    scale: [data.scale[i3], data.scale[i3 + 1], data.scale[i3 + 2]],
    rotation: [data.rotation[i4], data.rotation[i4 + 1], data.rotation[i4 + 2], data.rotation[i4 + 3]],
    color: [data.color[i4], data.color[i4 + 1], data.color[i4 + 2], data.color[i4 + 3]],
    opacity: data.color[i4 + 3],
  };
}
