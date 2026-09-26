import { parseMiniXml } from "./mini-xml";
import type { AnimationChannel, AnimationData, MaterialData, MeshData, ModelData, ModelNode } from "./types";

/**
 * Parse Collada XML into a Document. Uses a real DOMParser when available;
 * on the native runtime DOMParser is an empty Pixi stub, so fall back to the
 * built-in mini parser when the result has no COLLADA root.
 */
function parseColladaDocument(text: string): Document {
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (doc.getElementsByTagName("COLLADA").length > 0) return doc;
    } catch { /* stub or unavailable — fall through */ }
  }
  return parseMiniXml(text) as unknown as Document;
}

// Minimal DOM-based Collada parser
// Supports: mesh (positions, normals, UVs), materials, textures, animations, node hierarchy

interface DAESource {
  id: string;
  data: number[];
  stride: number;
}

interface DAEInput {
  semantic: string;
  source: string;
  offset: number;
  set?: number;
}

interface DAEPrimitive {
  type: "triangles" | "polylist" | "tristrips";
  count: number;
  inputs: DAEInput[];
  indices: number[];
  vcount?: number[];
  material?: string;
}

interface DAEVertices {
  id: string;
  inputs: DAEInput[];
}

interface DAEGeometry {
  id: string;
  name: string;
  sources: Map<string, DAESource>;
  vertices: Map<string, DAEVertices>;
  primitives: DAEPrimitive[];
}

interface DAEMaterial {
  id: string;
  name: string;
  diffuseColor: [number, number, number, number];
  diffuseTexture?: string;
  normalTexture?: string;
  specularColor: [number, number, number];
  shininess: number;
}

function parseFloatArray(text: string): number[] {
  return text.trim().split(/\s+/).map(Number).filter(v => !isNaN(v));
}

function parseIntArray(text: string): number[] {
  return text.trim().split(/\s+/).map(Number).filter(v => !isNaN(v));
}

function getAttr(el: Element, name: string): string | undefined {
  const val = el.getAttribute(name);
  return val ?? undefined;
}

function parseSources(geometryEl: Element): Map<string, DAESource> {
  const sources = new Map<string, DAESource>();
  const sourceEls = geometryEl.getElementsByTagName("source");
  for (let i = 0; i < sourceEls.length; i++) {
    const src = sourceEls[i];
    const id = src.getAttribute("id") ?? "";
    const floatArrayEl = src.getElementsByTagName("float_array")[0];
    if (!floatArrayEl) continue;
    const data = parseFloatArray(floatArrayEl.textContent ?? "");
    const techniqueEl = src.getElementsByTagName("accessor")[0];
    const stride = techniqueEl ? parseInt(techniqueEl.getAttribute("stride") ?? "3") : 3;
    sources.set(id, { id, data, stride });
  }
  return sources;
}

function parseInputs(parentEl: Element): DAEInput[] {
  const inputs: DAEInput[] = [];
  const inputEls = parentEl.getElementsByTagName("input");
  for (let i = 0; i < inputEls.length; i++) {
    const input = inputEls[i];
    const semantic = input.getAttribute("semantic") ?? "";
    const source = (input.getAttribute("source") ?? "").replace("#", "");
    const offset = parseInt(input.getAttribute("offset") ?? "0");
    const setAttr = input.getAttribute("set");
    inputs.push({ semantic, source, offset, set: setAttr ? parseInt(setAttr) : undefined });
  }
  return inputs;
}

function parseGeometries(doc: Document): Map<string, DAEGeometry> {
  const geometries = new Map<string, DAEGeometry>();
  const geomEls = doc.getElementsByTagName("geometry");
  for (let i = 0; i < geomEls.length; i++) {
    const geomEl = geomEls[i];
    const id = geomEl.getAttribute("id") ?? `geom_${i}`;
    const name = geomEl.getAttribute("name") ?? id;
    const meshEl = geomEl.getElementsByTagName("mesh")[0];
    if (!meshEl) continue;

    const sources = parseSources(meshEl);

    // Parse vertices elements (Collada VERTEX semantic points to these)
    const verticesMap = new Map<string, DAEVertices>();
    const vertEls = meshEl.getElementsByTagName("vertices");
    for (let j = 0; j < vertEls.length; j++) {
      const vertEl = vertEls[j];
      const vertId = vertEl.getAttribute("id") ?? "";
      const vertInputs: DAEInput[] = [];
      const vertInputEls = vertEl.getElementsByTagName("input");
      for (let k = 0; k < vertInputEls.length; k++) {
        const inp = vertInputEls[k];
        vertInputs.push({
          semantic: inp.getAttribute("semantic") ?? "",
          source: (inp.getAttribute("source") ?? "").replace("#", ""),
          offset: parseInt(inp.getAttribute("offset") ?? "0"),
          set: inp.getAttribute("set") ? parseInt(inp.getAttribute("set")!) : undefined,
        });
      }
      verticesMap.set(vertId, { id: vertId, inputs: vertInputs });
    }

    const primitives: DAEPrimitive[] = [];

    // Parse triangles
    const triEls = meshEl.getElementsByTagName("triangles");
    for (let j = 0; j < triEls.length; j++) {
      const triEl = triEls[j];
      const count = parseInt(triEl.getAttribute("count") ?? "0");
      const inputs = parseInputs(triEl);
      const pEl = triEl.getElementsByTagName("p")[0];
      const indices = pEl ? parseIntArray(pEl.textContent ?? "") : [];
      const material = getAttr(triEl, "material");
      primitives.push({ type: "triangles", count, inputs, indices, material });
    }

    // Parse polylist
    const polyEls = meshEl.getElementsByTagName("polylist");
    for (let j = 0; j < polyEls.length; j++) {
      const polyEl = polyEls[j];
      const count = parseInt(polyEl.getAttribute("count") ?? "0");
      const inputs = parseInputs(polyEl);
      const pEl = polyEl.getElementsByTagName("p")[0];
      const indices = pEl ? parseIntArray(pEl.textContent ?? "") : [];
      const vcountEl = polyEl.getElementsByTagName("vcount")[0];
      const vcount = vcountEl ? parseIntArray(vcountEl.textContent ?? "") : [];
      const material = getAttr(polyEl, "material");
      primitives.push({ type: "polylist", count, inputs, indices, vcount, material });
    }

    // Parse tristrips
    const stripEls = meshEl.getElementsByTagName("tristrips");
    for (let j = 0; j < stripEls.length; j++) {
      const stripEl = stripEls[j];
      const count = parseInt(stripEl.getAttribute("count") ?? "0");
      const inputs = parseInputs(stripEl);
      const pEl = stripEl.getElementsByTagName("p")[0];
      const indices = pEl ? parseIntArray(pEl.textContent ?? "") : [];
      const material = getAttr(stripEl, "material");
      primitives.push({ type: "tristrips", count, inputs, indices, material });
    }

    geometries.set(id, { id, name, sources, vertices: verticesMap, primitives });
  }
  return geometries;
}

function parseMaterials(doc: Document): Map<string, DAEMaterial> {
  const materials = new Map<string, DAEMaterial>();
  const matEls = doc.getElementsByTagName("material");
  const effectMap = new Map<string, Element>();

  // Build effect map
  const effectEls = doc.getElementsByTagName("effect");
  for (let i = 0; i < effectEls.length; i++) {
    const id = effectEls[i].getAttribute("id") ?? "";
    effectMap.set(id, effectEls[i]);
  }

  for (let i = 0; i < matEls.length; i++) {
    const matEl = matEls[i];
    const id = matEl.getAttribute("id") ?? `mat_${i}`;
    const name = matEl.getAttribute("name") ?? id;

    let diffuseColor: [number, number, number, number] = [0.7, 0.7, 0.7, 1];
    let diffuseTexture: string | undefined;
    let normalTexture: string | undefined;
    let specularColor: [number, number, number] = [0, 0, 0];
    let shininess = 0;

    // Find instance_effect
    const instEffect = matEl.getElementsByTagName("instance_effect")[0];
    if (instEffect) {
      const effectUrl = (instEffect.getAttribute("url") ?? "").replace("#", "");
      const effectEl = effectMap.get(effectUrl);
      if (effectEl) {
        // Find phong/lambert/Blinn profile
        const profileEls = effectEl.getElementsByTagName("profile_COMMON");
        for (let p = 0; p < profileEls.length; p++) {
          const profile = profileEls[p];
          const techniqueEls = profile.getElementsByTagName("technique");
          for (let t = 0; t < techniqueEls.length; t++) {
            const technique = techniqueEls[t];
            const shadingEls = ["phong", "lambert", "blinn", "Blinn"];
            for (let s = 0; s < shadingEls.length; s++) {
              const shadingEl = technique.getElementsByTagName(shadingEls[s])[0];
              if (!shadingEl) continue;

              const diffuseEl = shadingEl.getElementsByTagName("diffuse")[0];
              if (diffuseEl) {
                const colorEl = diffuseEl.getElementsByTagName("color")[0];
                const textureEl = diffuseEl.getElementsByTagName("texture")[0];
                if (colorEl) {
                  const c = parseFloatArray(colorEl.textContent ?? "");
                  if (c.length >= 3) {
                    diffuseColor = [c[0], c[1], c[2], c[3] ?? 1];
                  }
                }
                if (textureEl) {
                  const texName = textureEl.getAttribute("texture") ?? "";
                  // Find the surface/sampler to get the image URI
                  const newParamEls = profile.getElementsByTagName("newparam");
                  for (let np = 0; np < newParamEls.length; np++) {
                    const sid = newParamEls[np].getAttribute("sid");
                    if (sid === texName) {
                      const samplerEl = newParamEls[np].getElementsByTagName("sampler2D")[0];
                      if (samplerEl) {
                        const sourceEl = samplerEl.getElementsByTagName("source")[0];
                        if (sourceEl) {
                          const surfaceName = sourceEl.textContent?.trim();
                          if (surfaceName) {
                            // Find the surface newparam
                            for (let np2 = 0; np2 < newParamEls.length; np2++) {
                              const surfSid = newParamEls[np2].getAttribute("sid");
                              if (surfSid === surfaceName) {
                                const initFromEl = newParamEls[np2].getElementsByTagName("init_from")[0];
                                if (initFromEl) {
                                  const imageId = initFromEl.textContent?.trim();
                                  if (imageId) {
                                    const imageEl = doc.getElementById(imageId);
                                    if (imageEl) {
                                      const initFrom = imageEl.getElementsByTagName("init_from")[0];
                                      diffuseTexture = initFrom?.textContent?.trim();
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }

              const specularEl = shadingEl.getElementsByTagName("specular")[0];
              if (specularEl) {
                const colorEl = specularEl.getElementsByTagName("color")[0];
                if (colorEl) {
                  const c = parseFloatArray(colorEl.textContent ?? "");
                  if (c.length >= 3) specularColor = [c[0], c[1], c[2]];
                }
              }

              const shininessEl = shadingEl.getElementsByTagName("shininess")[0];
              if (shininessEl) {
                const floatEl = shininessEl.getElementsByTagName("float")[0];
                if (floatEl) {
                  shininess = parseFloat(floatEl.textContent?.trim() ?? "0");
                }
              }

              // Bump/normal map
              const bumpEl = shadingEl.getElementsByTagName("bump")[0];
              if (bumpEl) {
                const textureEl = bumpEl.getElementsByTagName("texture")[0];
                if (textureEl) {
                  normalTexture = textureEl.getAttribute("texture") ?? undefined;
                }
              }
            }
          }
        }
      }
    }

    materials.set(id, { id, name, diffuseColor, diffuseTexture, normalTexture, specularColor, shininess });
  }
  return materials;
}

function parseNodes(doc: Document): ModelNode[] {
  const result: ModelNode[] = [];
  const nodeEls = doc.getElementsByTagName("node");
  for (let i = 0; i < nodeEls.length; i++) {
    const nodeEl = nodeEls[i];
    const name = nodeEl.getAttribute("name") ?? nodeEl.getAttribute("id") ?? `node_${i}`;
    const id = nodeEl.getAttribute("id") ?? `node_${i}`;

    let translation: [number, number, number] | undefined;
    let rotation: [number, number, number, number] | undefined;
    let scale: [number, number, number] | undefined;

    // Parse transforms
    const childEls = nodeEl.children;
    const rotations: { axis: [number, number, number]; angle: number }[] = [];
    for (let j = 0; j < childEls.length; j++) {
      const child = childEls[j];
      const tagName = child.tagName.toLowerCase();
      if (tagName === "translate") {
        const v = parseFloatArray(child.textContent ?? "");
        if (v.length >= 3) translation = [v[0], v[1], v[2]];
      } else if (tagName === "rotate") {
        const v = parseFloatArray(child.textContent ?? "");
        if (v.length >= 4) {
          rotations.push({ axis: [v[0], v[1], v[2]], angle: v[3] * Math.PI / 180 });
        }
      } else if (tagName === "scale") {
        const v = parseFloatArray(child.textContent ?? "");
        if (v.length >= 3) scale = [v[0], v[1], v[2]];
      } else if (tagName === "matrix") {
        const v = parseFloatArray(child.textContent ?? "");
        if (v.length >= 16) {
          // Extract translation from matrix
          translation = [v[12], v[13], v[14]];
        }
      }
    }

    // Combine rotations into a single quaternion
    if (rotations.length > 0) {
      let qx = 0, qy = 0, qz = 0, qw = 1;
      for (let r = 0; r < rotations.length; r++) {
        const rot = rotations[r];
        const halfAngle = rot.angle / 2;
        const s = Math.sin(halfAngle);
        const c = Math.cos(halfAngle);
        const ax = rot.axis[0], ay = rot.axis[1], az = rot.axis[2];
        const len = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
        const nx = ax / len, ny = ay / len, nz = az / len;
        const rqx = s * nx, rqy = s * ny, rqz = s * nz, rqw = c;
        // Quaternion multiplication: q = q * rq
        const newW = qw * rqw - qx * rqx - qy * rqy - qz * rqz;
        const newX = qw * rqx + qx * rqw + qy * rqz - qz * rqy;
        const newY = qw * rqy - qx * rqz + qy * rqw + qz * rqx;
        const newZ = qw * rqz + qx * rqy - qy * rqx + qz * rqw;
        qx = newX; qy = newY; qz = newZ; qw = newW;
      }
      rotation = [qx, qy, qz, qw];
    }

    result.push({ name, children: undefined, translation, rotation, scale });
  }
  return result;
}

function parseAnimations(doc: Document): AnimationData[] {
  const animations: AnimationData[] = [];
  const animEls = doc.getElementsByTagName("animation");
  const sourceMap = new Map<string, number[]>();

  // Collect all sources from all animations
  const allSourceEls = doc.getElementsByTagName("source");
  for (let i = 0; i < allSourceEls.length; i++) {
    const srcEl = allSourceEls[i];
    const id = srcEl.getAttribute("id") ?? "";
    const floatArrayEl = srcEl.getElementsByTagName("float_array")[0];
    if (floatArrayEl) {
      sourceMap.set(id, parseFloatArray(floatArrayEl.textContent ?? ""));
    }
  }

  for (let i = 0; i < animEls.length; i++) {
    const animEl = animEls[i];
    const name = animEl.getAttribute("name") ?? animEl.getAttribute("id") ?? `anim_${i}`;

    const channels: AnimationChannel[] = [];
    let maxTime = 0;

    // Parse samplers
    const samplerEls = animEl.getElementsByTagName("sampler");
    const samplers: { input: number[]; output: number[]; interpolation: string }[] = [];

    for (let j = 0; j < samplerEls.length; j++) {
      const samplerEl = samplerEls[j];
      let input: number[] = [];
      let output: number[] = [];
      let interpolation = "LINEAR";

      const inputEls = samplerEl.getElementsByTagName("input");
      for (let k = 0; k < inputEls.length; k++) {
        const inputEl = inputEls[k];
        const semantic = inputEl.getAttribute("semantic");
        const source = (inputEl.getAttribute("source") ?? "").replace("#", "");
        if (semantic === "INPUT") {
          input = sourceMap.get(source) ?? [];
        } else if (semantic === "OUTPUT") {
          output = sourceMap.get(source) ?? [];
        } else if (semantic === "INTERPOLATION") {
          const interpData = sourceMap.get(source);
          if (interpData && interpData.length > 0) {
            // Names array - not float_array, need to get from Name_array
            const nameArrayEl = samplerEl.ownerDocument!.getElementById(source);
            if (nameArrayEl) {
              const nameArray = nameArrayEl.getElementsByTagName("Name_array")[0] ??
                nameArrayEl.getElementsByTagName("float_array")[0];
              if (nameArray) {
                const interpText = (nameArray.textContent ?? "").trim().split(/\s+/);
                if (interpText.length > 0) interpolation = interpText[0];
              }
            }
          }
        }
      }

      samplers.push({ input, output, interpolation });
    }

    // Parse channel targets
    const channelEls = animEl.getElementsByTagName("channel");
    for (let j = 0; j < channelEls.length; j++) {
      const channelEl = channelEls[j];
      const target = channelEl.getAttribute("target") ?? "";
      const source = (channelEl.getAttribute("source") ?? "").replace("#", "");

      // Find the sampler index
      const samplerIdx = samplers.findIndex((_, idx) => {
        const samplerEl = samplerEls[idx];
        return samplerEl.getAttribute("id") === source;
      });

      if (samplerIdx < 0) continue;
      const sampler = samplers[samplerIdx];

      // Parse target: "nodeName/transform(0)" or "nodeName/transform"
      const targetParts = target.split("/");
      if (targetParts.length < 2) continue;
      const nodeName = targetParts[0];
      const transformPart = targetParts[1].split("(")[0].toLowerCase();

      let path: "translation" | "rotation" | "scale" = "translation";
      if (transformPart.includes("translate")) path = "translation";
      else if (transformPart.includes("rotate")) path = "rotation";
      else if (transformPart.includes("scale")) path = "scale";

      // Determine component count
      const components = path === "rotation" ? 4 : 3;
      const keyframeCount = sampler.input.length;

      for (let t = 0; t < keyframeCount; t++) {
        if (sampler.input[t] > maxTime) maxTime = sampler.input[t];
      }

      const times = new Float32Array(keyframeCount);
      for (let t = 0; t < keyframeCount; t++) {
        times[t] = sampler.input[t];
      }

      const values = new Float32Array(keyframeCount * components);
      for (let t = 0; t < keyframeCount; t++) {
        for (let c = 0; c < components && t * components + c < sampler.output.length; c++) {
          values[t * components + c] = sampler.output[t * components + c];
        }
      }

      channels.push({
        targetNode: nodeName,
        path,
        keyframeTimes: times,
        keyframeValues: values,
        interpolation: sampler.interpolation as "LINEAR" | "STEP" | "CUBICSPLINE",
      });
    }

    if (channels.length > 0) {
      animations.push({ name, duration: maxTime, channels });
    }
  }

  return animations;
}

function geometryToMeshes(geom: DAEGeometry, materials: Map<string, DAEMaterial>): MeshData[] {
  const meshes: MeshData[] = [];

  for (let p = 0; p < geom.primitives.length; p++) {
    const prim = geom.primitives[p];

    // Find input offsets and sources
    const maxOffset = Math.max(...prim.inputs.map(inp => inp.offset));
    const stride = maxOffset + 1;

    // Map semantic to source
    const posSource = prim.inputs.find(inp => inp.semantic === "VERTEX");
    const normSource = prim.inputs.find(inp => inp.semantic === "NORMAL");
    const uvSource = prim.inputs.find(inp => inp.semantic === "TEXCOORD");

    // Resolve vertex source (VERTEX semantic points to a source that may reference POSITION)
    let posData: number[] = [];
    let posStride = 3;
    let normData: number[] = [];
    let normStride = 3;
    let uvData: number[] = [];
    let uvStride = 2;

    if (posSource) {
      // In Collada, VERTEX semantic points to a <vertices> element,
      // which has inputs (e.g. POSITION) that point to actual <source> elements
      const vertEl = geom.vertices.get(posSource.source);
      if (vertEl) {
        // Resolve POSITION input from vertices element
        const posInput = vertEl.inputs.find(inp => inp.semantic === "POSITION");
        if (posInput) {
          const src = geom.sources.get(posInput.source);
          if (src) {
            posData = src.data;
            posStride = src.stride;
          }
        }
      } else {
        // Direct source reference (non-standard but handle it)
        const src = geom.sources.get(posSource.source);
        if (src) {
          posData = src.data;
          posStride = src.stride;
        }
      }
    }
    if (normSource) {
      const src = geom.sources.get(normSource.source);
      if (src) {
        normData = src.data;
        normStride = src.stride;
      }
    }
    if (uvSource) {
      const src = geom.sources.get(uvSource.source);
      if (src) {
        uvData = src.data;
        uvStride = src.stride;
      }
    }

    if (posData.length === 0) continue;

    // Build vertices
    const vertexMap = new Map<string, number>();
    const vertices: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    // Get material color for this primitive
    let matColor: [number, number, number] = [0.7, 0.7, 0.75];
    if (prim.material && materials.has(prim.material)) {
      const mat = materials.get(prim.material)!;
      matColor = [mat.diffuseColor[0], mat.diffuseColor[1], mat.diffuseColor[2]];
    }

    function addVertex(posIdx: number, normIdx: number, uvIdx: number): number {
      const key = `${posIdx}/${normIdx}/${uvIdx}`;
      let idx = vertexMap.get(key);
      if (idx === undefined) {
        idx = vertices.length / 6;
        const px = posData[posIdx * posStride] ?? 0;
        const py = posData[posIdx * posStride + 1] ?? 0;
        const pz = posData[posIdx * posStride + 2] ?? 0;
        let nx = 0, ny = 1, nz = 0;
        if (normData.length > 0) {
          nx = normData[normIdx * normStride] ?? 0;
          ny = normData[normIdx * normStride + 1] ?? 0;
          nz = normData[normIdx * normStride + 2] ?? 0;
        }
        vertices.push(px, py, pz, nx, ny, nz);

        if (uvData.length > 0) {
          const u = uvData[uvIdx * uvStride] ?? 0;
          const v = 1.0 - (uvData[uvIdx * uvStride + 1] ?? 0);
          uvs.push(u, v);
        } else {
          uvs.push(0, 0);
        }

        colors.push(matColor[0], matColor[1], matColor[2]);
        vertexMap.set(key, idx);
      }
      return idx;
    }

    const posOff = posSource?.offset ?? 0;
    const normOff = normSource?.offset ?? 0;
    const uvOff = uvSource?.offset ?? 0;

    if (prim.type === "triangles") {
      const triCount = prim.count;
      for (let t = 0; t < triCount; t++) {
        for (let v = 0; v < 3; v++) {
          const idxBase = (t * 3 + v) * stride;
          const posIdx = prim.indices[idxBase + posOff];
          const normIdx = normSource ? prim.indices[idxBase + normOff] : posIdx;
          const uvIdx = uvSource ? prim.indices[idxBase + uvOff] : posIdx;
          indices.push(addVertex(posIdx, normIdx, uvIdx));
        }
      }
    } else if (prim.type === "polylist" && prim.vcount) {
      let idxPtr = 0;
      for (let poly = 0; poly < prim.vcount.length; poly++) {
        const vcount = prim.vcount[poly];
        const polyVerts: number[] = [];
        for (let v = 0; v < vcount; v++) {
          const posIdx = prim.indices[idxPtr + posOff];
          const normIdx = normSource ? prim.indices[idxPtr + normOff] : posIdx;
          const uvIdx = uvSource ? prim.indices[idxPtr + uvOff] : posIdx;
          polyVerts.push(addVertex(posIdx, normIdx, uvIdx));
          idxPtr += stride;
        }
        // Fan triangulation
        for (let v = 1; v < polyVerts.length - 1; v++) {
          indices.push(polyVerts[0], polyVerts[v], polyVerts[v + 1]);
        }
      }
    } else if (prim.type === "tristrips") {
      // Triangle strips: each strip of N vertices produces N-2 triangles
      const vertCount = prim.count;
      for (let v = 0; v < vertCount; v++) {
        const posIdx = prim.indices[v * stride + posOff];
        const normIdx = normSource ? prim.indices[v * stride + normOff] : posIdx;
        const uvIdx = uvSource ? prim.indices[v * stride + uvOff] : posIdx;
        const mappedIdx = addVertex(posIdx, normIdx, uvIdx);
        if (v >= 2) {
          // Alternate winding for strips
          if (v % 2 === 0) {
            indices.push(mappedIdx - 2, mappedIdx - 1, mappedIdx);
          } else {
            indices.push(mappedIdx - 1, mappedIdx - 2, mappedIdx);
          }
        }
      }
    }

    const vertArray = new Float32Array(vertices);
    const idxArray = indices.length > 65535
      ? new Uint32Array(indices)
      : new Uint16Array(indices);

    meshes.push({
      vertices: vertArray,
      indices: idxArray,
      vertexCount: vertices.length / 6,
      indexCount: indices.length,
      uvs: uvData.length > 0 ? new Float32Array(uvs) : null,
      colors: new Float32Array(colors),
    });
  }

  return meshes;
}

export function parseDAE(data: ArrayBuffer, name: string): ModelData {
  const text = new TextDecoder().decode(data);
  const doc = parseColladaDocument(text);

  // Check for parse errors
  const parseError = doc.getElementsByTagName("parsererror");
  if (parseError.length > 0) {
    throw new Error("Failed to parse DAE XML");
  }

  const geometries = parseGeometries(doc);
  const materials = parseMaterials(doc);
  const nodes = parseNodes(doc);
  const animations = parseAnimations(doc);

  // Parse <asset> element for up-axis and unit metadata.
  // Collada defaults: Y-up, 1 meter.
  let sourceUpAxis: "y" | "z" = "y";
  let sourceUnits: "meters" | "centimeters" | "inches" | "millimeters" | "units" = "meters";
  const assetElements = doc.getElementsByTagName("asset");
  if (assetElements.length > 0) {
    const asset = assetElements[0];
    const upAxisEl = asset.getElementsByTagName("up_axis");
    if (upAxisEl.length > 0) {
      const val = upAxisEl[0].textContent?.trim().toUpperCase() ?? "";
      if (val === "Z_UP") sourceUpAxis = "z";
    }
    const unitEl = asset.getElementsByTagName("unit");
    if (unitEl.length > 0) {
      const meterAttr = unitEl[0].getAttribute("meter");
      if (meterAttr) {
        const metersPerUnit = parseFloat(meterAttr);
        if (metersPerUnit === 1) sourceUnits = "meters";
        else if (metersPerUnit === 0.01) sourceUnits = "centimeters";
        else if (metersPerUnit === 0.0254) sourceUnits = "inches";
        else if (metersPerUnit === 0.001) sourceUnits = "millimeters";
        else sourceUnits = "units";
      }
    }
  }

  // Convert geometries to meshes
  const meshes: MeshData[] = [];
  const materialList: MaterialData[] = [];

  // Build material list
  for (const [, mat] of materials.entries()) {
    materialList.push({
      name: mat.name,
      baseColor: mat.diffuseColor,
      metallic: 0,
      roughness: mat.shininess > 0 ? Math.max(0.1, 1 - mat.shininess / 1000) : 1,
      textureUri: mat.diffuseTexture,
      normalTextureUri: mat.normalTexture,
    });
  }

  for (const [, geom] of geometries.entries()) {
    const geomMeshes = geometryToMeshes(geom, materials);
    for (let i = 0; i < geomMeshes.length; i++) {
      meshes.push(geomMeshes[i]);
    }
  }

  return {
    meshes,
    name,
    format: "dae",
    materials: materialList.length > 0 ? materialList : undefined,
    animations: animations.length > 0 ? animations : undefined,
    nodes: nodes.length > 0 ? nodes : undefined,
    sourceUpAxis,
    sourceUnits,
  };
}
