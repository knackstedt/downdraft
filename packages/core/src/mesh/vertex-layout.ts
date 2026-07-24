export interface VertexAttribute {
  name: string;
  format: "float32x3" | "float32x2" | "float32x4" | "uint16x2" | "uint8x4";
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
