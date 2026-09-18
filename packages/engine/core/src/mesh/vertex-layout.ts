export type VertexAttributeFormat =
  | "float32x3"
  | "float32x2"
  | "float32x4"
  | "float32"
  | "uint16x2"
  | "uint16x4"
  | "uint8x4"
  | "unorm8x4";

export interface VertexAttribute {
  name: string;
  format: VertexAttributeFormat;
  offset: number;
}

export interface VertexLayout {
  attributes: VertexAttribute[];
  stride: number;
}

export const STANDARD_VERTEX_LAYOUT: VertexLayout = {
  attributes: [
    { name: "position", format: "float32x3", offset: 0 },
    { name: "normal", format: "float32x3", offset: 12 },
    { name: "uv", format: "float32x2", offset: 24 },
    { name: "color", format: "float32x4", offset: 32 },
  ],
  stride: 48,
};

export const PBR_VERTEX_LAYOUT: VertexLayout = {
  attributes: [
    { name: "position", format: "float32x3", offset: 0 },
    { name: "normal", format: "float32x3", offset: 12 },
    { name: "uv", format: "float32x2", offset: 24 },
    { name: "tangent", format: "float32x4", offset: 32 },
  ],
  stride: 48,
};

export const SKINNED_VERTEX_LAYOUT: VertexLayout = {
  attributes: [
    { name: "position", format: "float32x3", offset: 0 },
    { name: "normal", format: "float32x3", offset: 12 },
    { name: "uv", format: "float32x2", offset: 24 },
    { name: "tangent", format: "float32x4", offset: 32 },
    { name: "boneIndices", format: "uint16x4", offset: 48 },
    { name: "boneWeights", format: "float32x4", offset: 56 },
  ],
  stride: 72,
};

export function vertexFormatSize(format: VertexAttributeFormat): number {
  switch (format) {
    case "float32x3": return 12;
    case "float32x2": return 8;
    case "float32x4": return 16;
    case "float32": return 4;
    case "uint16x2": return 4;
    case "uint16x4": return 8;
    case "uint8x4": return 4;
    case "unorm8x4": return 4;
  }
}

export function wgslVertexFormat(format: VertexAttributeFormat): string {
  switch (format) {
    case "float32x3": return "vec3<f32>";
    case "float32x2": return "vec2<f32>";
    case "float32x4": return "vec4<f32>";
    case "float32": return "f32";
    case "uint16x2": return "vec2<u32>";
    case "uint16x4": return "vec4<u32>";
    case "uint8x4": return "vec4<u32>";
    case "unorm8x4": return "vec4<f32>";
  }
}

export function gpuVertexFormat(format: VertexAttributeFormat): GPUVertexFormat {
  switch (format) {
    case "float32x3": return "float32x3";
    case "float32x2": return "float32x2";
    case "float32x4": return "float32x4";
    case "float32": return "float32";
    case "uint16x2": return "uint16x2";
    case "uint16x4": return "uint16x4";
    case "uint8x4": return "uint8x4";
    case "unorm8x4": return "unorm8x4";
  }
}
