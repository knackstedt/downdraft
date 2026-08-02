export interface GaussianSplat {
  id: string;
  position: Float32Array;  // x, y, z per splat
  scale: Float32Array;     // x, y, z per splat
  rotation: Float32Array;  // quaternion w, x, y, z per splat
  color: Float32Array;     // r, g, b, a per splat
  count: number;
}

export interface GaussianSplatConfig {
  maxSplats: number;
  splatSize: number;
  enableSorting: boolean;
  sortFrequency: number;
  sphericalHarmonicsDegree: number;
}

export const DEFAULT_SPLAT_CONFIG: GaussianSplatConfig = {
  maxSplats: 1_000_000,
  splatSize: 0.01,
  enableSorting: true,
  sortFrequency: 10,
  sphericalHarmonicsDegree: 0,
};

export const SPLAT_FLOATS_PER_VERTEX = 14; // 3 pos + 4 rot + 3 scale + 4 color

export function parsePlySplatData(data: ArrayBuffer): GaussianSplat {
  const view = new DataView(data);
  const decoder = new TextDecoder();
  let offset = 0;

  // Parse PLY header
  let line = "";
  const headerLines: string[] = [];
  while (offset < data.byteLength) {
    const byte = view.getUint8(offset++);
    if (byte === 0x0a) { // newline
      headerLines.push(line);
      if (line === "end_header") break;
      line = "";
    } else {
      line += String.fromCharCode(byte);
    }
  }

  // Parse vertex count and properties
  let vertexCount = 0;
  const properties: string[] = [];
  for (const hLine of headerLines) {
    if (hLine.startsWith("element vertex ")) {
      vertexCount = parseInt(hLine.split(" ")[2], 10);
    } else if (hLine.startsWith("property ")) {
      const parts = hLine.split(" ");
      properties.push(parts[parts.length - 1]);
    }
  }

  // Map property names to indices
  const propIndex: Record<string, number> = {};
  properties.forEach((prop, i) => { propIndex[prop] = i; });

  const floatsPerVertex = properties.length;
  const positions = new Float32Array(vertexCount * 3);
  const scales = new Float32Array(vertexCount * 3);
  const rotations = new Float32Array(vertexCount * 4);
  const colors = new Float32Array(vertexCount * 4);

  // Read vertex data (assuming float32 properties)
  for (let i = 0; i < vertexCount; i++) {
    const base = offset + i * floatsPerVertex * 4;
    const x = propIndex["x"] !== undefined ? view.getFloat32(base + propIndex["x"] * 4, true) : 0;
    const y = propIndex["y"] !== undefined ? view.getFloat32(base + propIndex["y"] * 4, true) : 0;
    const z = propIndex["z"] !== undefined ? view.getFloat32(base + propIndex["z"] * 4, true) : 0;
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    const sx = propIndex["scale_0"] !== undefined ? view.getFloat32(base + propIndex["scale_0"] * 4, true) : 0.01;
    const sy = propIndex["scale_1"] !== undefined ? view.getFloat32(base + propIndex["scale_1"] * 4, true) : 0.01;
    const sz = propIndex["scale_2"] !== undefined ? view.getFloat32(base + propIndex["scale_2"] * 4, true) : 0.01;
    scales[i * 3] = Math.exp(sx);
    scales[i * 3 + 1] = Math.exp(sy);
    scales[i * 3 + 2] = Math.exp(sz);

    const rw = propIndex["rot_0"] !== undefined ? view.getFloat32(base + propIndex["rot_0"] * 4, true) : 1;
    const rx = propIndex["rot_1"] !== undefined ? view.getFloat32(base + propIndex["rot_1"] * 4, true) : 0;
    const ry = propIndex["rot_2"] !== undefined ? view.getFloat32(base + propIndex["rot_2"] * 4, true) : 0;
    const rz = propIndex["rot_3"] !== undefined ? view.getFloat32(base + propIndex["rot_3"] * 4, true) : 0;
    rotations[i * 4] = rw;
    rotations[i * 4 + 1] = rx;
    rotations[i * 4 + 2] = ry;
    rotations[i * 4 + 3] = rz;

    const r = propIndex["f_dc_0"] !== undefined ? view.getFloat32(base + propIndex["f_dc_0"] * 4, true) : 0.5;
    const g = propIndex["f_dc_1"] !== undefined ? view.getFloat32(base + propIndex["f_dc_1"] * 4, true) : 0.5;
    const b = propIndex["f_dc_2"] !== undefined ? view.getFloat32(base + propIndex["f_dc_2"] * 4, true) : 0.5;
    const a = propIndex["opacity"] !== undefined ? view.getFloat32(base + propIndex["opacity"] * 4, true) : 1.0;
    // SH C0 coefficient to color: color = 0.5 + C0 * 0.282095
    colors[i * 4] = Math.max(0, Math.min(1, 0.5 + r * 0.282095));
    colors[i * 4 + 1] = Math.max(0, Math.min(1, 0.5 + g * 0.282095));
    colors[i * 4 + 2] = Math.max(0, Math.min(1, 0.5 + b * 0.282095));
    // Opacity is stored as log-sigmoid: alpha = 1 / (1 + exp(-opacity))
    colors[i * 4 + 3] = 1.0 / (1.0 + Math.exp(-a));
  }

  return {
    id: `splat-${Date.now()}`,
    position: positions,
    scale: scales,
    rotation: rotations,
    color: colors,
    count: vertexCount,
  };
}

export function sortSplatsByDepth(
  splat: GaussianSplat,
  cameraPos: [number, number, number],
): Uint32Array {
  const indices = new Uint32Array(splat.count);
  const depths = new Float32Array(splat.count);

  for (let i = 0; i < splat.count; i++) {
    indices[i] = i;
    const dx = splat.position[i * 3] - cameraPos[0];
    const dy = splat.position[i * 3 + 1] - cameraPos[1];
    const dz = splat.position[i * 3 + 2] - cameraPos[2];
    depths[i] = dx * dx + dy * dy + dz * dz;
  }

  // Sort by depth (back to front for alpha blending)
  indices.sort((a, b) => depths[b] - depths[a]);

  return indices;
}

export function packSplatToVertexBuffer(splat: GaussianSplat): Float32Array {
  const buf = new Float32Array(splat.count * SPLAT_FLOATS_PER_VERTEX);
  for (let i = 0; i < splat.count; i++) {
    const offset = i * SPLAT_FLOATS_PER_VERTEX;
    buf[offset] = splat.position[i * 3];
    buf[offset + 1] = splat.position[i * 3 + 1];
    buf[offset + 2] = splat.position[i * 3 + 2];
    buf[offset + 3] = splat.rotation[i * 4];
    buf[offset + 4] = splat.rotation[i * 4 + 1];
    buf[offset + 5] = splat.rotation[i * 4 + 2];
    buf[offset + 6] = splat.rotation[i * 4 + 3];
    buf[offset + 7] = splat.scale[i * 3];
    buf[offset + 8] = splat.scale[i * 3 + 1];
    buf[offset + 9] = splat.scale[i * 3 + 2];
    buf[offset + 10] = splat.color[i * 4];
    buf[offset + 11] = splat.color[i * 4 + 1];
    buf[offset + 12] = splat.color[i * 4 + 2];
    buf[offset + 13] = splat.color[i * 4 + 3];
  }
  return buf;
}

export const GAUSSIAN_SPLAT_SHADER = /* wgsl */ `
struct SplatUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  splatSize: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
};

struct SplatVertex {
  @location(0) position: vec3<f32>,
  @location(1) rotation: vec4<f32>,
  @location(2) scale: vec3<f32>,
  @location(3) color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: SplatUniforms;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) quadCoord: vec2<f32>,
};

fn quatRotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let qv = q.xyz;
  let qw = q.w;
  let t = 2.0 * cross(qv, v);
  return v + qw * t + cross(qv, t);
}

@vertex
fn vs_main(splat: SplatVertex, @builtin(vertex_index) vi: u32) -> VertexOutput {
  // Each splat is a quad (2 triangles = 6 vertices)
  let quadVerts = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
  );
  let quadCoord = quadVerts[vi % 6u];

  // Compute splat quad in world space
  let right = normalize(vec3<f32>(u.viewProj[0].xyz));
  let up = normalize(vec3<f32>(u.viewProj[1].xyz));
  let worldOffset = quatRotate(splat.rotation, vec3<f32>(quadCoord * splat.scale.xy, 0.0));
  let worldPos = splat.position + worldOffset;

  var output: VertexOutput;
  output.clipPosition = u.viewProj * vec4<f32>(worldPos, 1.0);
  output.color = splat.color;
  output.quadCoord = quadCoord;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Gaussian falloff
  let d = dot(input.quadCoord, input.quadCoord);
  let alpha = exp(-d * 3.0) * input.color.a;
  if (alpha < 0.01) { discard; }
  return vec4<f32>(input.color.rgb, alpha);
}
`;
