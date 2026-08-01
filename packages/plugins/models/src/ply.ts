import type { MeshData, ModelData } from "./types.ts";

interface PLYProperty {
  name: string;
  type: string;
  isList: boolean;
  countType?: string;
}

interface PLYElement {
  name: string;
  count: number;
  properties: PLYProperty[];
}

interface PLYHeader {
  format: "ascii" | "binary_little_endian" | "binary_big_endian";
  version: string;
  elements: PLYElement[];
}

function parsePLYHeader(data: ArrayBuffer): { header: PLYHeader; headerLength: number } {
  const bytes = new Uint8Array(data);
  const decoder = new TextDecoder();
  let offset = 0;
  let headerText = "";

  while (offset < bytes.length) {
    const nl = bytes.indexOf(10, offset); // newline
    if (nl === -1) break;
    const line = decoder.decode(bytes.subarray(offset, nl));
    headerText += line + "\n";
    offset = nl + 1;
    if (line.trim() === "end_header") break;
  }

  const lines = headerText.split("\n");
  const header: PLYHeader = {
    format: "ascii",
    version: "1.0",
    elements: [],
  };

  let currentElement: PLYElement | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("comment")) continue;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];

    if (cmd === "format" && parts.length >= 3) {
      header.format = parts[1] as PLYHeader["format"];
      header.version = parts[2];
    } else if (cmd === "element" && parts.length >= 3) {
      currentElement = {
        name: parts[1],
        count: parseInt(parts[2], 10),
        properties: [],
      };
      header.elements.push(currentElement);
    } else if (cmd === "property" && currentElement) {
      if (parts[1] === "list" && parts.length >= 5) {
        currentElement.properties.push({
          name: parts[4],
          type: parts[3],
          isList: true,
          countType: parts[2],
        });
      } else if (parts.length >= 3) {
        currentElement.properties.push({
          name: parts[2],
          type: parts[1],
          isList: false,
        });
      }
    }
  }

  return { header, headerLength: offset };
}

function plyTypeSize(type: string): number {
  switch (type) {
    case "char": case "int8": return 1;
    case "uchar": case "uint8": return 1;
    case "short": case "int16": return 2;
    case "ushort": case "uint16": return 2;
    case "int": case "int32": return 4;
    case "uint": case "uint32": return 4;
    case "float": case "float32": return 4;
    case "double": case "float64": return 8;
    default: return 4;
  }
}

function readPLYValue(view: DataView, offset: number, type: string, littleEndian: boolean): [number, number] {
  switch (type) {
    case "char": case "int8": return [view.getInt8(offset), 1];
    case "uchar": case "uint8": return [view.getUint8(offset), 1];
    case "short": case "int16": return [view.getInt16(offset, littleEndian), 2];
    case "ushort": case "uint16": return [view.getUint16(offset, littleEndian), 2];
    case "int": case "int32": return [view.getInt32(offset, littleEndian), 4];
    case "uint": case "uint32": return [view.getUint32(offset, littleEndian), 4];
    case "float": case "float32": return [view.getFloat32(offset, littleEndian), 4];
    case "double": case "float64": return [view.getFloat64(offset, littleEndian), 8];
    default: return [0, 4];
  }
}

function parseASCIIPLY(data: ArrayBuffer, header: PLYHeader, headerLength: number, name: string): ModelData {
  const text = new TextDecoder().decode(new Uint8Array(data, headerLength));
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  const vertexElement = header.elements.find((e) => e.name === "vertex");
  const faceElement = header.elements.find((e) => e.name === "face");

  if (!vertexElement) throw new Error("PLY: no vertex element found");

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  let lineIdx = 0;

  // Read vertices
  for (let i = 0; i < vertexElement.count && lineIdx < lines.length; i++, lineIdx++) {
    const parts = lines[lineIdx].trim().split(/\s+/);
    let pi = 0;
    for (const prop of vertexElement.properties) {
      const val = parseFloat(parts[pi]);
      if (prop.name === "x") positions.push(val);
      else if (prop.name === "y") positions.push(val);
      else if (prop.name === "z") positions.push(val);
      else if (prop.name === "nx") normals.push(val);
      else if (prop.name === "ny") normals.push(val);
      else if (prop.name === "nz") normals.push(val);
      else if (prop.name === "s" || prop.name === "u") uvs.push(val);
      else if (prop.name === "t" || prop.name === "v") uvs.push(val);
      else if (prop.name === "red") colors.push(val / 255);
      else if (prop.name === "green") colors.push(val / 255);
      else if (prop.name === "blue") colors.push(val / 255);
      else if (prop.name === "alpha") colors.push(val / 255);
      pi++;
    }
  }

  // Read faces
  if (faceElement) {
    for (let i = 0; i < faceElement.count && lineIdx < lines.length; i++, lineIdx++) {
      const parts = lines[lineIdx].trim().split(/\s+/);
      const count = parseInt(parts[0], 10);
      if (count >= 3) {
        for (let j = 1; j < count - 1; j++) {
          indices.push(parseInt(parts[1], 10), parseInt(parts[j + 1], 10), parseInt(parts[j + 2], 10));
        }
      }
    }
  }

  const vertexCount = vertexElement.count;
  const hasNormals = normals.length > 0;
  const hasUVs = uvs.length > 0;
  const hasColors = colors.length > 0;

  // Build interleaved vertices (pos + normal = 6 floats)
  const vertices = new Float32Array(vertexCount * 6);
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 6] = positions[i * 3] ?? 0;
    vertices[i * 6 + 1] = positions[i * 3 + 1] ?? 0;
    vertices[i * 6 + 2] = positions[i * 3 + 2] ?? 0;
    vertices[i * 6 + 3] = hasNormals ? normals[i * 3] : 0;
    vertices[i * 6 + 4] = hasNormals ? normals[i * 3 + 1] : 0;
    vertices[i * 6 + 5] = hasNormals ? normals[i * 3 + 2] : 0;
  }

  const uvArray = hasUVs ? new Float32Array(uvs) : null;
  const colorArray = hasColors ? new Float32Array(colors) : null;

  const indexCount = indices.length;
  const indexArray = indexCount > 65535
    ? new Uint32Array(indices)
    : new Uint16Array(indices);

  const mesh: MeshData = {
    vertices: vertices,
    indices: indexArray,
    vertexCount,
    indexCount,
    uvs: uvArray,
    colors: colorArray,
  };

  return {
    meshes: [mesh],
    name,
    format: "ply",
  };
}

function parseBinaryPLY(data: ArrayBuffer, header: PLYHeader, headerLength: number, name: string): ModelData {
  const view = new DataView(data);
  const littleEndian = header.format === "binary_little_endian";
  let offset = headerLength;

  const vertexElement = header.elements.find((e) => e.name === "vertex");
  const faceElement = header.elements.find((e) => e.name === "face");

  if (!vertexElement) throw new Error("PLY: no vertex element found");

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];

  // Read vertices
  for (let i = 0; i < vertexElement.count; i++) {
    for (const prop of vertexElement.properties) {
      const [val, size] = readPLYValue(view, offset, prop.type, littleEndian);
      offset += size;

      if (prop.name === "x") positions.push(val);
      else if (prop.name === "y") positions.push(val);
      else if (prop.name === "z") positions.push(val);
      else if (prop.name === "nx") normals.push(val);
      else if (prop.name === "ny") normals.push(val);
      else if (prop.name === "nz") normals.push(val);
      else if (prop.name === "s" || prop.name === "u") uvs.push(val);
      else if (prop.name === "t" || prop.name === "v") uvs.push(val);
      else if (prop.name === "red") colors.push(val / 255);
      else if (prop.name === "green") colors.push(val / 255);
      else if (prop.name === "blue") colors.push(val / 255);
      else if (prop.name === "alpha") colors.push(val / 255);
    }
  }

  // Read faces
  const indices: number[] = [];
  if (faceElement) {
    for (let i = 0; i < faceElement.count; i++) {
      // Read list count
      const countProp = faceElement.properties.find((p) => p.isList);
      if (!countProp) {
        // Non-list face element, skip
        for (const prop of faceElement.properties) {
          const [, size] = readPLYValue(view, offset, prop.type, littleEndian);
          offset += size;
        }
        continue;
      }

      const [count, countSize] = readPLYValue(view, offset, countProp.countType!, littleEndian);
      offset += countSize;

      const faceIndices: number[] = [];
      for (let j = 0; j < count; j++) {
        const [idx, size] = readPLYValue(view, offset, countProp.type, littleEndian);
        offset += size;
        faceIndices.push(idx);
      }

      // Skip remaining properties
      for (const prop of faceElement.properties) {
        if (prop.isList) continue;
        const [, size] = readPLYValue(view, offset, prop.type, littleEndian);
        offset += size;
      }

      if (count >= 3) {
        for (let j = 0; j < count - 1; j++) {
          indices.push(faceIndices[0], faceIndices[j + 1], faceIndices[j + 2]);
        }
      }
    }
  }

  const vertexCount = vertexElement.count;
  const hasNormals = normals.length > 0;
  const hasUVs = uvs.length > 0;
  const hasColors = colors.length > 0;

  const vertices = new Float32Array(vertexCount * 6);
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 6] = positions[i * 3] ?? 0;
    vertices[i * 6 + 1] = positions[i * 3 + 1] ?? 0;
    vertices[i * 6 + 2] = positions[i * 3 + 2] ?? 0;
    vertices[i * 6 + 3] = hasNormals ? normals[i * 3] : 0;
    vertices[i * 6 + 4] = hasNormals ? normals[i * 3 + 1] : 0;
    vertices[i * 6 + 5] = hasNormals ? normals[i * 3 + 2] : 0;
  }

  const uvArray = hasUVs ? new Float32Array(uvs) : null;
  const colorArray = hasColors ? new Float32Array(colors) : null;

  const indexCount = indices.length;
  const indexArray = indexCount > 65535
    ? new Uint32Array(indices)
    : new Uint16Array(indices);

  const mesh: MeshData = {
    vertices,
    indices: indexArray,
    vertexCount,
    indexCount,
    uvs: uvArray,
    colors: colorArray,
  };

  return {
    meshes: [mesh],
    name,
    format: "ply",
  };
}

export function parsePLY(data: ArrayBuffer, name: string): ModelData {
  const { header, headerLength } = parsePLYHeader(data);

  if (header.format === "ascii") {
    return parseASCIIPLY(data, header, headerLength, name);
  } else {
    return parseBinaryPLY(data, header, headerLength, name);
  }
}
