import type { MaterialData, MeshData, ModelData } from "./types";

interface OBJMaterial {
  name: string;
  ambient: [number, number, number];
  diffuse: [number, number, number];
  specular: [number, number, number];
  shininess: number;
  opacity: number;
  diffuseTexture?: string;
  normalTexture?: string;
}

function parseMTL(text: string): Map<string, OBJMaterial> {
  const materials = new Map<string, OBJMaterial>();
  let current: OBJMaterial | null = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];

    if (cmd === "newmtl") {
      current = {
        name: parts[1] ?? "default",
        ambient: [1, 1, 1],
        diffuse: [0.7, 0.7, 0.7],
        specular: [0, 0, 0],
        shininess: 0,
        opacity: 1,
      };
      materials.set(current.name, current);
    } else if (current) {
      if (cmd === "Ka" && parts.length >= 4) {
        current.ambient = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])];
      } else if (cmd === "Kd" && parts.length >= 4) {
        current.diffuse = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])];
      } else if (cmd === "Ks" && parts.length >= 4) {
        current.specular = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])];
      } else if (cmd === "Ns" && parts.length >= 2) {
        current.shininess = parseFloat(parts[1]);
      } else if (cmd === "d" && parts.length >= 2) {
        current.opacity = parseFloat(parts[1]);
      } else if (cmd === "Tr" && parts.length >= 2) {
        current.opacity = 1 - parseFloat(parts[1]);
      } else if (cmd === "map_Kd" && parts.length >= 2) {
        current.diffuseTexture = parts.slice(1).join(" ");
      } else if (cmd === "map_Bump" && parts.length >= 2) {
        current.normalTexture = parts.slice(1).join(" ");
      } else if (cmd === "bump" && parts.length >= 2) {
        current.normalTexture = parts.slice(1).join(" ");
      }
    }
  }

  return materials;
}

export function parseOBJ(
  data: ArrayBuffer,
  name: string,
  mtlData?: ArrayBuffer | null,
  mtlFilename?: string,
): ModelData {
  const text = new TextDecoder().decode(data);
  const lines = text.split("\n");

  const positions: number[][] = [];
  const normals: number[][] = [];
  const uvs: number[][] = [];
  const faces: { posIdx: number; normIdx: number; uvIdx: number; matIdx: number }[][] = [];
  let currentMatIdx = 0;
  const materialNameToIdx = new Map<string, number>();
  const materialList: OBJMaterial[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];

    if (cmd === "v" && parts.length >= 4) {
      positions.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
    } else if (cmd === "vn" && parts.length >= 4) {
      normals.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
    } else if (cmd === "vt" && parts.length >= 3) {
      uvs.push([parseFloat(parts[1]), parseFloat(parts[2])]);
    } else if (cmd === "usemtl" && parts.length >= 2) {
      const matName = parts[1];
      if (materialNameToIdx.has(matName)) {
        currentMatIdx = materialNameToIdx.get(matName)!;
      } else {
        currentMatIdx = materialList.length;
        materialNameToIdx.set(matName, currentMatIdx);
        materialList.push({
          name: matName,
          ambient: [1, 1, 1],
          diffuse: [0.7, 0.7, 0.7],
          specular: [0, 0, 0],
          shininess: 0,
          opacity: 1,
        });
      }
    } else if (cmd === "f" && parts.length >= 4) {
      const face: { posIdx: number; normIdx: number; uvIdx: number; matIdx: number }[] = [];
      for (let j = 1; j < parts.length; j++) {
        const indices = parts[j].split("/");
        const posIdx = parseInt(indices[0]) - 1;
        const uvIdx = indices[1] ? parseInt(indices[1]) - 1 : -1;
        const normIdx = indices[2] ? parseInt(indices[2]) - 1 : -1;
        if (posIdx < 0 || posIdx >= positions.length) {
          throw new RangeError(`OBJ face vertex index out of bounds: ${posIdx + 1} (positions: ${positions.length})`);
        }
        if (uvIdx >= 0 && uvIdx >= uvs.length) {
          throw new RangeError(`OBJ face uv index out of bounds: ${uvIdx + 1} (uvs: ${uvs.length})`);
        }
        if (normIdx >= 0 && normIdx >= normals.length) {
          throw new RangeError(`OBJ face normal index out of bounds: ${normIdx + 1} (normals: ${normals.length})`);
        }
        face.push({ posIdx, normIdx, uvIdx, matIdx: currentMatIdx });
      }
      for (let j = 1; j < face.length - 1; j++) {
        faces.push([face[0], face[j], face[j + 1]]);
      }
    }
  }

  // Parse MTL if provided
  let materials: MaterialData[] | undefined;
  if (mtlData) {
    const mtlText = new TextDecoder().decode(mtlData);
    const mtlMaterials = parseMTL(mtlText);
    materials = [];
    const mtlEntries = Array.from(mtlMaterials.entries());
    for (let mi = 0; mi < mtlEntries.length; mi++) {
      const matName = mtlEntries[mi][0];
      const mat = mtlEntries[mi][1];
      materials.push({
        name: matName,
        baseColor: [mat.diffuse[0], mat.diffuse[1], mat.diffuse[2], mat.opacity],
        metallic: 0,
        roughness: mat.shininess > 0 ? Math.max(0.1, 1 - mat.shininess / 1000) : 1,
        textureUri: mat.diffuseTexture,
        textureData: null,
        normalTextureUri: mat.normalTexture,
      });
    }
    // Rebuild material index mapping and update materialList with MTL colors
    materialNameToIdx.clear();
    for (let mi = 0; mi < mtlEntries.length; mi++) {
      const matName = mtlEntries[mi][0];
      const mat = mtlEntries[mi][1];
      materialNameToIdx.set(matName, mi);
      // Update existing materialList entry or add new one
      if (mi < materialList.length) {
        materialList[mi] = {
          name: matName,
          ambient: mat.ambient,
          diffuse: mat.diffuse,
          specular: mat.specular,
          shininess: mat.shininess,
          opacity: mat.opacity,
          diffuseTexture: mat.diffuseTexture,
          normalTexture: mat.normalTexture,
        };
      } else {
        materialList.push({
          name: matName,
          ambient: mat.ambient,
          diffuse: mat.diffuse,
          specular: mat.specular,
          shininess: mat.shininess,
          opacity: mat.opacity,
          diffuseTexture: mat.diffuseTexture,
          normalTexture: mat.normalTexture,
        });
      }
    }
  } else {
    // No MTL file — build materials from the OBJ's internal material list
    if (materialList.length > 0) {
      materials = [];
      for (let mi = 0; mi < materialList.length; mi++) {
        const mat = materialList[mi];
        materials.push({
          name: mat.name,
          baseColor: [mat.diffuse[0], mat.diffuse[1], mat.diffuse[2], mat.opacity],
          metallic: 0,
          roughness: mat.shininess > 0 ? Math.max(0.1, 1 - mat.shininess / 1000) : 1,
          textureData: null,
        });
      }
    }
  }

  const hasUVs = uvs.length > 0;

  // Build interleaved vertex data
  const vertexMap = new Map<string, number>();
  const vertices: number[] = [];
  const indices: number[] = [];
  const uvArray: number[] = [];
  const colorArray: number[] = [];
  const vertMatIndices: number[] = [];

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    for (let v = 0; v < face.length; v++) {
      const vert = face[v];
      const key = `${vert.posIdx}/${vert.normIdx}/${vert.uvIdx}`;
      let idx = vertexMap.get(key);
      if (idx === undefined) {
        idx = vertices.length / 6;
        const pos = positions[vert.posIdx] ?? [0, 0, 0];
        const norm = vert.normIdx >= 0 ? (normals[vert.normIdx] ?? [0, 1, 0]) : [0, 1, 0];
        vertices.push(pos[0], pos[1], pos[2], norm[0], norm[1], norm[2]);

        if (hasUVs && vert.uvIdx >= 0) {
          const uv = uvs[vert.uvIdx] ?? [0, 0];
          uvArray.push(uv[0], 1.0 - uv[1]);
        } else {
          uvArray.push(0, 0);
        }

        // Vertex color from material diffuse
        const mat = materialList[vert.matIdx];
        if (mat) {
          colorArray.push(mat.diffuse[0], mat.diffuse[1], mat.diffuse[2]);
        } else {
          colorArray.push(0.7, 0.7, 0.75);
        }
        vertMatIndices.push(vert.matIdx);

        vertexMap.set(key, idx);
      }
      indices.push(idx);
    }
  }

  const vertArray = new Float32Array(vertices);
  const idxArray = indices.length > 65535
    ? new Uint32Array(indices)
    : new Uint16Array(indices);

  const mesh: MeshData = {
    vertices: vertArray,
    indices: idxArray,
    vertexCount: vertices.length / 6,
    indexCount: indices.length,
    uvs: hasUVs ? new Float32Array(uvArray) : null,
    colors: colorArray.length > 0 ? new Float32Array(colorArray) : null,
  };

  return {
    meshes: [mesh],
    name,
    format: "obj",
    materials,
  };
}
