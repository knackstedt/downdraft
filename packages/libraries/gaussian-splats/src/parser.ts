
import { assertBounds, assertCount, MAX_VERTEX_COUNT } from "@downdraft/core";

export interface GaussianSplat {
  position: [number, number, number];
  scale: [number, number, number];
  rotation: [number, number, number, number];
  color: [number, number, number, number];
  opacity: number;
}

export interface GaussianSplatData {
  splats: GaussianSplat[];
  count: number;
  shDegree: number;
  version: number;
}

export interface PLYHeader {
  vertexCount: number;
  properties: string[];
  format: string;
}

function readPLYHeader(data: Uint8Array): PLYHeader {
  const text = new TextDecoder().decode(data.slice(0, 2048));
  const lines = text.split("\n");
  let vertexCount = 0;
  const properties: string[] = [];
  let format = "ascii";
  let headerEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "end_header") {
      headerEnd = i + 1;
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
    }
  }

  return { vertexCount, properties, format };
}

export function parsePLY(data: Uint8Array): GaussianSplatData {
  const header = readPLYHeader(data);
  const splats: GaussianSplat[] = [];
  assertCount("splats", header.vertexCount, MAX_VERTEX_COUNT);

  if (header.format === "ascii") {
    const text = new TextDecoder().decode(data);
    const lines = text.split("\n");
    let dataStart = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "end_header") {
        dataStart = i + 1;
        break;
      }
    }

    for (let i = 0; i < header.vertexCount && dataStart + i < lines.length; i++) {
      const parts = lines[dataStart + i].trim().split(/\s+/).map(Number);
      if (parts.length < 3) continue;
      splats.push({
        position: [parts[0], parts[1], parts[2]],
        scale: [parts.length > 3 ? parts[3] : 0.01, parts.length > 4 ? parts[4] : 0.01, parts.length > 5 ? parts[5] : 0.01],
        rotation: [0, 0, 0, 1],
        color: [1, 1, 1, 1],
        opacity: 1,
      });
    }
  } else if (header.format === "binary_little_endian") {
    const headerText = new TextDecoder().decode(data.slice(0, 2048));
    const headerLineCount = headerText.split("\n").indexOf("end_header") + 1;
    let offset = 0;
    for (let i = 0; i < headerLineCount; i++) {
      offset += headerText.split("\n")[i].length + 1;
    }

    const view = new DataView(data.buffer, data.byteOffset + offset);
    const stride = header.properties.length * 4;
    // Validate data size vs vertexCount × stride
    assertBounds("splats binary data", offset, header.vertexCount * stride, data.byteLength);
    for (let i = 0; i < header.vertexCount; i++) {
      const base = i * stride;
      splats.push({
        position: [view.getFloat32(base, true), view.getFloat32(base + 4, true), view.getFloat32(base + 8, true)],
        scale: [0.01, 0.01, 0.01],
        rotation: [0, 0, 0, 1],
        color: [1, 1, 1, 1],
        opacity: 1,
      });
    }
  }

  return { splats, count: splats.length, shDegree: 0, version: 1 };
}

export function parseSplat(data: Uint8Array): GaussianSplatData {
  const splats: GaussianSplat[] = [];
  const stride = 32;
  const view = new DataView(data.buffer, data.byteOffset);
  const count = Math.floor(data.byteLength / stride);

  for (let i = 0; i < count; i++) {
    const base = i * stride;
    splats.push({
      position: [view.getFloat32(base, true), view.getFloat32(base + 4, true), view.getFloat32(base + 8, true)],
      scale: [
        Math.exp(view.getFloat32(base + 12, true)),
        Math.exp(view.getFloat32(base + 16, true)),
        Math.exp(view.getFloat32(base + 20, true)),
      ],
      rotation: [view.getFloat32(base + 24, true), view.getFloat32(base + 28, true), 0, 1],
      color: [1, 1, 1, 1],
      opacity: 1,
    });
  }

  return { splats, count, shDegree: 0, version: 2 };
}

export function parseGaussianSplatFile(data: Uint8Array, format: "ply" | "splat" = "ply"): GaussianSplatData {
  if (format === "splat") return parseSplat(data);
  return parsePLY(data);
}
